<!-- Moved verbatim from PLAN.md lines 9154–13273 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->

# Milestone 12 — the playtest round 4 and round 5 fix records

The `## Playtest round 4 —` and `## Playtest round 5 —` sections that followed the Milestone 12 proposal in PLAN.md, in the order they landed. The proposal itself stays in PLAN.md.

## Playtest round 4 — P9's bomb arrow pointed at the wrong place, and one component is not one calculation

A regression from P9's own F2, reported after it shipped. The brief asked for the mechanism
before the fix, and the mechanism is the more useful half: **P9 set out to remove a duplicated
bearing calculation and instead gave a wrong one a second consumer.**

### What P9 did, and why it made things worse rather than better

F2 asked for an arrow pointing at the bomb. `MatchObjectives` rules out HUD markers, so the
brief offered two routes, and route (a) said to reuse *"the mechanism that already exists for hit
direction (`HudTactical.showHitDirection`), one component for both uses rather than two that will
drift"*.

P9 read that, noticed correctly that `showHitDirection` is the **transient** member of the family
and `HudTactical.updateThreat` is the **persistent** one, and unified the bomb arrow with the
threat arrow into `BearingIndicator`. That reasoning is still right. What it did not do was look
inside the expression it was promoting, and it shipped a comment asserting the thing it had not
checked:

> *"Positive is to the right of the crosshair, which is the convention `Hud.showHitDirection`
> uses."*

It is not. There were **three** bearing calculations in the client and no two were the same:

    MatchFeedback   wrap(playerYaw - atan2(-(tx - px), -(tz - pz)))     hit chevrons
    HudTactical          atan2( (tx - px), -(tz - pz)) - playerYaw      grenade threat
    BearingIndicator     the second one, verbatim, now also the bomb    P9

`atan2(-a, b)` is `-atan2(a, b)`, so the first is `playerYaw + A` and the second is
`A - playerYaw`. **They differ by exactly twice the player's yaw.** `aimWithOffset` settles which
is right — this project's forward is `(-sin(yaw), -cos(yaw))` — and it is `MatchFeedback`'s.

So the grenade warning has pointed to the wrong place for as long as it has existed, and P9
doubled the number of surfaces standing on it. Measured over a target orbiting a stationary
player, at four headings:

| Player facing | Worst error in P9's shipped bearing |
|---|---|
| yaw 0 | **0 deg** |
| yaw 45 | **90 deg** |
| yaw 90 | **180 deg** — the arrow points at the opposite side of the map |
| yaw 180 | 0 deg (the error is `2 x yaw`, so it wraps back to zero here) |

The two seats where it is right are yaw 0 and yaw 180, and yaw 0 is where a fresh spawn faces.
That is the whole reason two rounds of playtesting did not catch the grenade arrow: the first
thing anybody does after a respawn is look at what is in front of them.

**The generalisable half, and it is a correction to P9's own conclusion.** P9's section says the
two arrows are "one component rather than two that will drift". One *component* is not one
*calculation*. Putting two callers behind one class removed the duplication that was visible in
the file tree and preserved the one that mattered, because the arithmetic inside was never the
thing being reviewed — it was pixels, and no probe in this project renders. The same sentence
could have been written about `showHitDirection`, which was the correct implementation and stayed
outside the new component entirely.

### The fix is a function, not a component

`shared/ui/ScreenProjection.ts` is the one place that turns a world point into a screen
direction. It takes **matrices** rather than a yaw — `camera.matrixWorldInverse.elements` and
`camera.projectionMatrix.elements`, column-major, which is what `THREE.Matrix4` already holds —
so it describes exactly what the renderer will do rather than a hand-derived approximation of it,
and it lives in `shared/` for the reason `Crosshair` and `HudSurfaces` do: `shared/` compiles
without `three` and without the DOM, so this process can run it.

It returns a `ScreenPoint`: ndc, pixels, `onScreen`, `depth`, `behind`, and `bearingRad`.

Two decisions worth stating:

- **`bearingRad` is taken from view space, before the perspective divide.** That is what makes it
  defined for a target behind the camera and continuous all the way round. Projected position is
  not: for a point behind the camera `w` is negative, so the ndc that comes out is a *mirrored*
  position that looks entirely plausible and is 180 degrees wrong. An off-screen indicator that
  trusts it tracks the reflection of the thing it is pointing at. `behind` is a returned flag
  rather than a caller's `if`, for the same reason `null` and `[]` are different in the tag
  channel: the caller has to be told, not left to notice.
- **The camera's world matrix is refreshed before it is read.** `matrixWorldInverse` is maintained
  by `WebGLRenderer.render`, and the HUD runs before the draw, so reading it unrefreshed gives
  last frame's camera. One frame of lag on an arrow is invisible — and "invisible" is precisely
  how a bearing stayed wrong for a milestone, so it is refreshed explicitly.

All three call sites now go through it: the two ring arrows project once each in `MatchHud`,
where the world positions are already assembled into one record per frame, and `MatchFeedback`
projects the shooter. `BearingIndicator.update` takes `(active, bearingRad)` and does no
geometry at all — it is a DOM write, which is all it should ever have been.

### The intel filter, re-confirmed

P9 required the arrow to respect the intel filter, and it still does, by construction rather than
by a check. `MatchObjectives.bombBearing.active` has exactly two writers: `update` clears it to
`false` at the top of every frame, and `updateBomb` sets it to
`mode.bomb === 'CARRIED' && mode.carrierId < 0`. There is no code path that can hand the HUD a
**carried** bomb's coordinates, so the arrow cannot track a living player through geometry, and
Ghost — which is about players and never about a dropped object — has nothing to filter here.
Changing the arithmetic did not touch that: `MatchHud` projects whatever
`readObjectiveBearing` reports, and it reports nothing while the bomb is held or planted.

Read rather than measured, and it is stated that way because it is a claim about which branches
exist and this process builds no `MatchObjectives`.

### Measured

`npm run readability` — the projection half is new, and the three properties are the ones the
brief named.

| Probe | Result |
|---|---|
| A point 10 m ahead / 10 m behind | not behind (depth 10.00 m) / **behind** (depth -10.00 m) |
| A behind point is never `onScreen` | holds |
| A point on the view axis | **960.0, 540.0 px** at 1920x1080 — the exact centre — bearing **0.000000 rad** |
| A target 45 deg to the right | **45.000 deg**, x = 1500 px |
| Bearing tracks a target orbiting the player, 72 positions | worst error **2.5e-14 deg** at yaw 0, 45, 90 and 180 |
| **Red control — P9's shipped bearing, same orbit** | **0 / 90 / 180 / 0 deg** of error at those four yaws |
| Projection checks failed | **0**, and the run exits non-zero if any fail |

The red control is the point of the table. It is the arithmetic that shipped, run against the
same orbit, and it prints the size of the bug rather than a claim about it.

Everything else, as regression controls — this session touches no simulation and no wire, so
none of these should move and none did:

| Probe | Result |
|---|---|
| `npm run harness`, 5 matches, seeds 1-5 | **75-59, 75-66, 62-75, 75-66, 60-75** — byte-identical to P5's and P9's baselines |
| `npm run skirmish`, 3 clients, shipped timings | **FLOW CHECK PASSED**; divergence **0 / 7373** per client; mispredictions into a live match **0** |
| Spectator invariants | 5692 selections while dead, **0 self / 0 enemy / 0 dead** |
| Quick loadout window | 9257 ticks over 27 windows, **0 while alive** |
| Per-life grenade stock | 102 life-starts, **0 partial / 0 empty**, 252 held against 252 expected |
| `npm run leak`, 100 cycles | subscriptions **29 -> 29 (+0)**, heap 12.99 -> 13.69 MiB |
| `npm run check` and `npm run build` | green — boundaries (297 files), cosmetics, unlocks, cheats, all three typecheck targets |

No protocol change.

### The sights report: what was checked, and what was not found

The brief's other item was a sights regression, with the hypothesis that P9 mutates a `three`
material or a uniform in place on an instance other weapons also hold. **That hypothesis is
dead, and no replacement for it was found.** Recorded in full because a search that came up empty
is worth exactly as much as one that did not, provided it says where it looked:

- **P9 mutates no material and no uniform.** Its B2 change adds two `BoxPart`s (`lens`,
  `reticle`) to the `scope` branch of `opticBoxes` and sets `openEnded: true` on two tubes. Both
  are *geometry*. The only reads of the shared material map in the whole weapon path are
  `WeaponMesh:170` and `KnifeMesh:154/177`, and all three assign a material to a mesh.
- **Nothing disposes the shared set.** `disposeWeaponSurfaces` has no callers, which
  `WeaponPreview`'s own comment already records — so P3's second WebGL context cannot pull the
  materials out from under the first.
- **The killfeed silhouettes are unaffected.** `WeaponSilhouette.drawable` filters on the surface
  key, so the two new quads are skipped by construction and P3's "12 weapons, 12 distinct" still
  describes the shipped icons.
- **The new glass is nowhere near the near plane.** The viewmodel camera's near is 0.008 m and
  the ADS pose puts the weapon root at z = -0.275; the LONGBOW's ocular lens sits at local
  z = +0.0765, so it lands about 0.20 m in front of the camera. It cannot be clipped.
- **The weapon files have not been touched since P9.** `git diff --name-only a30792b..HEAD` over
  `src/client/weapons/` is empty, so whatever is wrong is either P9's or older than it.

What that leaves is a real report with no mechanism attached to it yet, and P0 is explicit that a
fix without a named mechanism is rejected. So nothing was changed in the weapon meshes this
session, and the next step is a description of what the sights actually do — which weapon, iron
sights or optic, hip or ADS — because the difference between "the LONGBOW's scope shows the world
twice" and "every red dot has gone" points at opposite halves of the file.

### Needs a browser

`HeadlessClient` builds no `ClientMatch` and no DOM, and the preview pane never fires
`requestAnimationFrame`. The projection is now arithmetic and is measured; that it is wired to
the right camera, and that the arrow is where the eye expects it, are pixels.

- **The bomb arrow, and this is the one that was broken.** Search & Destroy, as an attacker.
  Stand still, put the loose bomb behind you, and **turn on the spot through a full circle**. The
  arrow must sweep smoothly and always point at the bomb — before this it was correct facing one
  way, ninety degrees out at the diagonals, and pointing at the exact opposite side of the map
  when you faced yaw 90. Walk a circle around the bomb and check it again.
- **The grenade threat arrow, which was wrong before P9 and is fixed here as a side effect.**
  Have somebody throw a grenade at you while you are facing across the map rather than down it.
  The chevron must point at the grenade. This has never been right.
- **The two arrows together.** Get a grenade thrown at you while the bomb is loose: both arrows
  up, pointing at different things, distinguishable at a glance.
- **The arrow still goes away.** Watch somebody pick the bomb up: the arrow must vanish on that
  frame and must not come back after a plant. That is the intel rule and it is the one thing here
  a wrong fix would quietly remove.
- **The directional hit indicator.** Get shot from behind and from each side while facing a
  non-zero heading. This one was already correct and is now computed differently, so it is the
  regression check on the change rather than a fix.

Unchanged from the earlier lists: everything under P9's own "needs a browser", and the
arena-return residual of 1-3 sub-25 cm mispredictions.

### Found while here

- **`Hud.showHitDirection` was the only correct one of the three, and it was the one P9 did not
  reuse.** The brief that produced P9 named it explicitly. P9 read past the name to the
  behaviour — transient versus persistent — concluded the *component* was the wrong one to copy,
  and in doing so skipped the *calculation*, which was the half worth copying. Worth keeping: when
  a brief names a thing to reuse, the reason it names it may not be the reason you find when you
  open it.
- **`viewMatrixFrom` and `perspectiveMatrixFrom` exist so the projection can be measured without
  `three`.** They are not used by the client, which hands over the camera's real matrices. They
  are the reason the table above is a measurement rather than an assertion, and the reason the red
  control could be run at all — and they are a second implementation of something `three` already
  does, which is a cost worth naming rather than hiding: if `CameraRig` ever changes its rotation
  order away from `YXZ`, this file has to follow and nothing will notice on its own.
- **`Math.sin`, `Math.cos` and `Math.tan` are banned in `shared/` and `server/`** by
  `check-boundaries`, and `Math.atan2` is not. The ban list is about determinism, and the bearing
  is presentation — but the rule caught this file twice on the way in and the substitution is
  free, so it uses `simSin`/`simCos`/`simTan` and the exception was not widened. `atan2` staying
  off the list is worth knowing before somebody assumes it is covered.

---

## Playtest round 4 — the scope with no hole in it had no hole for a reason

The second half of the P9 follow-up, reported with four screenshots: `LONGBOW MK3` and both
snipers. Everything else was confirmed good — *"in all other weapons the sights work great"* —
and, importantly, *"with the sniper scopes that enter scope mode it also works well"*.

Those two sentences are the diagnosis. The three weapons that are wrong are exactly the three
with `optic: 'scope'` in their model spec, the part that still works is the ADS **overlay**, and
what is broken is the **viewmodel at hip fire**.

### What P9 did, and why it could not have worked

P9's B2 fix set `openEnded: true` on the scope tube and its objective bell, so that a player
aiming the LONGBOW could see through the optic rather than at the flat back of a capped cylinder.
The diagnosis behind it was right and is unchanged: `ar_longbow` is the only weapon whose *model*
carries a scope and whose *def* does not, so it gets neither the viewmodel hand-off nor the
overlay, and the tube sits on the sight line with nothing to replace it.

The fix was wrong twice.

**It did not restore a sight picture, only a hole.** An optic is not a tube you look down; the
picture through it is drawn by `HudTactical`'s scope overlay, which is exactly the machinery the
LONGBOW was excluded from. Opening the tube let the eye through to the world at ADS with a
26 mm square of glass and a 2.6 mm speck floating in it — not a sight.

**And an open cylinder is a single-sided surface.** `CylinderGeometry` with `openEnded` builds
the side wall and nothing else, and the material is `FrontSide`. From outside, the near wall's
faces are drawn and the far wall's are culled, so the moment the camera can see into either end
the tube stops being an object and becomes a curved sheet. At hip fire the camera sits *behind*
the weapon and looks along it, which is precisely into the ocular end. All three scoped weapons
became a hollow trough with a red dot floating in the middle of it. The screenshots show it
exactly, and they show it on the two snipers too — weapons whose sight picture was never broken
and which P9 changed anyway, on the argument that the two extra quads were "invisible" on them.

P9's own record put "an open-ended tube looks right from outside at hip" on the **needs a
browser** list, with the note that backface culling makes the interior invisible *"but it is a
claim about a rasteriser"*. It came back red. That list is doing its job; what it cannot do is
stop a change shipping on the strength of a claim it has flagged as unverified.

### The fix is the mismatch, not the mesh

`WeaponMeshParts` and `WeaponMesh` are restored to exactly their pre-P9 state — solid capped
tubes, no `openEnded` flag, no lens, no reticle, no `scopeOcularZ`. `git checkout a30792b~1` on
both files, so this is byte-identical to the geometry that shipped for eleven milestones.

**`ar_longbow` gets `optic: 'reddot'`.** That is where the bug always was. P9 named the mismatch
correctly and then fixed the wrong end of it: a scope model on a weapon the simulation does not
scope is a sight the player cannot see through, and the answer is to stop modelling a scope on
it rather than to drill a hole in the scope. A red dot is built by the same M7 code the two SMGs,
the HALCYON and the MONOLITH use — the code the report confirms *"works great"* — its aperture is
clear by construction, and it costs the simulation nothing: no magnification, no scope-in time,
no breath, no sway, and not one line of `WeaponDefs`.

What it costs is the word "scoped" in the spec's comment. The rifle keeps its identity where it
came from in the first place: the longest handguard and barrel in the game, a skeleton stock and
a short magazine. B2 stays fixed, by the mechanism that was already proven rather than a new one.

### The class of bug is a check that fails

`scripts/check-optics.mjs`, wired into `npm run check` between the cosmetic and unlock audits.
One rule, both ways round:

- a weapon modelled `optic: 'scope'` **must** have a `scope` block in its def — otherwise aiming
  it puts a tube on the sight line and nothing hands the picture to the overlay;
- a weapon whose def **has** a scope block must be modelled with one — otherwise the overlay
  replaces a viewmodel that never had a scope on it, which is the same defect wearing the other
  hat and would be reported as *"my sniper has no scope"* and diagnosed from scratch.

Watched red both ways, and the first control is the bug exactly as it shipped:

| Red control | What it said |
|---|---|
| `ar_longbow` restored to `optic: 'scope'` — **the bug as reported** | *is modelled with optic: 'scope' but its WeaponDef has no scope block* |
| `sniper_kestrel` set to `optic: 'reddot'` | *has a scope block in its WeaponDef but is modelled with optic: 'reddot'* |

**And the audit was wrong on its first run, in the way this milestone keeps producing.** It
reported *"10 model specs"* against twelve weapons and passed, because it only recorded entries
that named an `optic:` — and most specs are `{ ...AR_BASE, ... }` and inherit it. `ar_vulcan` was
being skipped silently. It resolves `AR_BASE` now and prints its denominators: **12 weapons
examined, 11 with their own spec, 1 inheriting**. A check that quietly examines five sixths of
its subject is the third probe in this milestone to have shipped as a false green, and the only
reason this one did not is that the count looked wrong on the line it printed.

Its limits are `check-cosmetics`' and `check-unlocks`': it reads sources with regular
expressions, so it knows a spec *names* a scope and a def *has* one, and it knows nothing about
what either renders.

### Measured

Nothing in this session touches the simulation or the wire, so every harness number below is a
control and none of them should have moved.

| Probe | Result |
|---|---|
| `npm run check` | boundaries (297 files), cosmetics, **optics**, unlocks, cheats, all three typecheck targets — green |
| Optic audit red controls | **2 of 2 went red**, including the bug as it shipped |
| `npm run readability` | crosshair 0 of 48 at the floor · team colour 0 of 12 violations · **projection 11 of 11**, red control still 0/90/180/0 deg |
| `npm run harness`, seeds 1-5 | **75-59, 75-66, 62-75, 75-66, 60-75** — byte-identical to P5, P9 and the projection session |
| `npm run skirmish`, shipped timings | **FLOW CHECK PASSED**; divergence **0 / 7374** per client; mispredictions into a live match **0** |
| Spectator invariants | 4812 selections while dead, **0 self / 0 enemy / 0 dead** |
| Per-life grenade stock | 110 life-starts, **0 partial / 0 empty**, 260 held against 260 expected |
| `npm run leak`, 100 cycles | subscriptions **29 -> 29 (+0)**, heap 13.02 -> 13.69 MiB |
| `npm run build` | green |

No protocol change.

### What was not verified

**The thing this session is about is a picture, and this process draws nothing.** The geometry is
restored to a state that shipped for eleven milestones and was never reported, which is the
strongest evidence available here and is not the same as having looked. The red dot on the
LONGBOW is new on that weapon and has not been seen on it.

One measured claim from P3 is now stale and is not re-measured here: **the killfeed silhouettes.**
`weaponSilhouettePath` projects the model's parts, and removing the LONGBOW's scope tube removes
several quads from its outline, so P3's *"12 weapons, 12 distinct silhouettes, 19-25 quads each"*
no longer describes the shipped roster. `WeaponSilhouette` is in `client/` and the probe is in
`server/`, which `check-boundaries` forbids from importing it, so this could not be re-run. The
rifle keeps the longest barrel and handguard in the game and a skeleton stock, so it should stay
distinct — that is a reasoned expectation, not a measurement, and it is on the browser list.

### Needs a browser

- **The three weapons in the report, at hip fire, first.** `LONGBOW MK3`, `KESTREL .338` and
  `VANTAGE SR`. Each must read as a **solid object**. The snipers must look exactly as they did
  before round 4 — that is the whole of their fix, and if either still shows a trough the revert
  did not take.
- **The LONGBOW aimed.** A red dot on the sight line and a clear view past it, the same picture
  the HALCYON and the SMGs give. This is B2, fixed a second time and a different way.
- **The snipers aimed.** Unchanged: the viewmodel goes at `SCOPE_VIEWMODEL_HIDDEN` and the
  overlay draws. The report confirms this already works; it is here as the regression check.
- **The killfeed icon for the LONGBOW**, at its real size, against the other three ARs. It has
  lost its scope and this is the claim above that could not be measured.
- **Everything on the projection session's list**, unchanged — the bomb arrow through a full turn
  is still the one to check first.

### Found while here

- **P9 changed two weapons it had no reason to touch.** The mismatch was `ar_longbow` alone; the
  snipers were named in P9's own record as weapons where the change would be "invisible", and
  they are two of the three in the screenshots. A change justified by "this cannot matter here"
  applied to things outside the reported defect is the cheapest thing to leave out and was the
  larger half of the damage.
- **`openEnded` is gone from `TubePart` entirely.** It had one user and that user is reverted, so
  it is a flag with no writer — the shape P3 removed `uiFocus` and `editorOpen` for. Restoring the
  files from `a30792b~1` took it out by construction rather than by remembering to.
- **The two failed B2 fixes bracket the right one.** The first said the mesh must change and the
  def must not; the second said the same thing more aggressively. The answer was that neither
  had to change — the *pairing* did, and the pairing was a third thing that no file owned. That
  is what `check-optics` now owns.

## Playtest round 4 — F14's entitlements outlived the seats they were granted on

A regression from the session above, reported from a browser: the cheat tag reading
`CHEATS · WALLET` still on screen in the pre-match freeze of round one of a Search & Destroy
match. The caption is the smallest part of what was wrong.

**The element, described rather than linked**, because the screenshot belongs to the session it
was taken in: `.hud-cheat` is a small dark box with an amber border and amber uppercase text,
horizontally centred, sitting about 12% of the viewport up from the bottom edge — just above the
killstreak strip. In the report it read `CHEATS · WALLET` over a fresh match: `GET READY · 8`,
`ROUND 1`, the S&D brief line under it, the quick class panel open down the left.

### What in the previous session's own change produced it

One sentence: **F14 put the entitlement store on the `Session`, and a `Session` outlives the thing
every entitlement in it was granted against.**

The reasoning at the time is quoted in the section above — *"on the Session rather than on the
seat, and for the same reason `loadout` and `reconnectToken` are: it is a fact about the
connection"*. That is right for those two and wrong for this one, and the difference is what the
fact is *about*:

- a `loadout` is deliberately re-applied to the next seat, which is the whole point of holding it
  across a migration;
- a `reconnectToken` identifies the connection itself;
- an **entitlement** is granted against an entity in one instance — the entity whose
  `invulnerable` and `participating` read it — and `MatchInstance.unseat` destroys that entity,
  its streak ledger row (`removePlayer` runs `StreakSystem.onOwnerRemoved`, which is `onDeath`
  plus `ledger.forget`) and its snapshot encoder.

So every grant crossed a boundary that had already thrown away its subject. `unseat` deleted the
entity, the encoder and the seat and said nothing about the entitlements, because when it was
written there were none.

### Two consequences, and the caption is the smaller one

**1. God mode, invisibility and free cam survived a migration.** This is the one the brief asked
to have reported if it were true, and it is. A code typed in the arena followed the player into
the live match the ballot sent them to. It is the *silent* form of the bug, and the reason it is
silent is the reason it matters: god mode in the arena does **nothing at all**, because F7 already
spares every combatant in that room — so the entitlement's first observable effect was in a match
nobody had typed a code in. Measured below at 313 hits refused at the live match's damage door for
a client whose code was typed before the migration.

**2. The wallet receipt outlived the wallet.** `MO951357` pays into a streak ledger row that
`onOwnerRemoved` forgets at the migration, and the `Cheat.Wallet` bit that recorded the payment
did not. The tag went on claiming an audit trail for a balance that no longer existed — which is
worse than no tag, because the tag exists so that a bug report can be attributed and this one was
attributing a state the player was not in.

### The modelling error under (2), which this file had already argued against

F14's own `CheatEffect` comment says it: *"a wallet top-up is a transaction, not a state anybody
can be **in**, and modelling it as an entitlement would have meant a bit that means 'has been
paid', which is true forever and pays only once."* And then it gave the payment a bit anyway, as
an attribution flag, and rendered the whole tag from the mask. The argument was written and not
followed.

So transient-versus-continuous is a **declared property of the code** now rather than a special
case for one of them:

```
export type CheatKind = 'toggle' | 'instant';
```

A `'toggle'` is a state: it has a bit, it is replicated, and the tag shows it for as long as it is
true. An `'instant'` is a transaction: it has no bit, nothing replicates it, and the HUD
*announces* it. `cheatCaption(mask, instantLabel)` composes the two, so the next instant cheat
needs nothing in the HUD — which was the point of the change rather than a side effect of it.
`Cheat.Wallet` is gone from the bit table entirely, and the durable record of a payment is where a
transaction's record belongs: the server's log line and `StreakEconomyReport.credited`.

The two lifetimes **compose rather than displace**: with god mode on, typing the code reads
`CHEATS · GOD · +30 KILLS` for four seconds and then `CHEATS · GOD`. Hiding a standing warning to
show a transient one would have been the wrong way round.

### Every entitlement, its lifetime, and where it is cleared

The table F14 should have contained. It is in `shared/cheats/Cheats.ts` as well, beside the bits.

| Entitlement | Kind | Lifetime | Cleared, server | Cleared, client |
|---|---|---|---|---|
| ~~`Cheat.Debug`~~ | surface | **the session** — the tab | never granted server-side | **the bit is deleted**; `DEBUG666` writes `debugRequest`, which the ×, Escape, the pause button and the code all write. Still deliberately survives a migration and a rotation |
| `Cheat.God` | toggle | **the seat** — one instance | `MatchInstance.unseat` | `NetClient.onWelcome`'s §4.18 discard |
| `Cheat.Unseen` | toggle | the seat | `MatchInstance.unseat` | same |
| `Cheat.NoClip` | toggle | the seat | `MatchInstance.unseat` | same |
| the wallet payment | **instant** | the payment is over when it lands; what it pays *into* belongs to a life (`StreakLedger.resetLife`) | nothing to clear — no bit is kept | expires after `CHEAT_NOTICE_SECONDS`; `onMigrated` drops it |

Two rows are worth reading twice.

**`Cheat.Debug` is the one that must *not* be cleared on a migration**, and it is the reason the
client half of the fix is not simply "clear everything". It is a client surface with no simulation
behind it, and P1 built `debugRequest` to survive a world being torn down and rebuilt for exactly
this reason — *"the request lives on `Game` rather than on the overlay because it has to outlive
the surface"*. A developer who unlocked the overlay and then got migrated should still have it.

**The server clears the entitlement and the client's caption is cleared separately**, and the
brief asked whether the two could disagree. They cannot, and the reason is that neither half is
load-bearing alone:

- the server's `unseat` clear is what ends the *effect*;
- `NetClient.onWelcome` discards the replica with the rest of §4.18's list, so the client does not
  hold a stale bit for the snapshot interval before the new instance's first frame;
- and the instant caption is a client-only presentation with no server state behind it, so it is
  cleared on the client and nowhere else.

If the server's clear were the only half, the tag would linger for one snapshot interval. If the
client's were the only half, the tag would go and god mode would stay — which is precisely the
shape of the bug being fixed, and the reason the caption was never the thing to fix.

### Where the clear went, and it was already the right place

`Game.skirmishSink().onMigrated` already discards the replicated streaks, the replicated
projectiles and the vote overlay, under one heading that has been in this file since round three:
*state from an instance you have left.* The instant caption is the fourth entry in that list and
needed no new mechanism. On the server the matching place is `MatchInstance.unseat`, beside
`releaseEntity` and `encoders.delete` — everything of this seat, in one function, for both causes.

Cleared for a **disconnect** as well as a migration, deliberately. A disconnect takes the session
with it, so on that path it is a no-op that costs nothing; the alternative was a `cause` test whose
two arms would have to be kept in step with a rule that has no reason to distinguish them.

### The display duration, and why it is not the thing P0 bans

`CHEAT_NOTICE_SECONDS` is **4**, named and written down rather than picked silently.

P0 bans *"a timer or delay to let state settle"* — a timer standing in for a signal that has not
arrived yet. This is not that, and the distinction is worth stating rather than asserting: nothing
waits on this number. The payment has already landed, been debited into the ledger and logged by
the time the caption goes up; the caption expiring changes no state at all, and if it never
expired the only consequence would be a word on a screen. It is the same kind of number as
`HudTactical`'s 1.1 s hit-direction chevron and the damage numbers' fade — presentation with a
lifetime.

It is counted down from a **deadline** rather than integrated as a duration, which is B4's lesson
taken at its word: a duration is only true at the instant it is created, and one integrated per
frame keeps counting through a pause, a rotation and a migration. `Game.instantCheatUntilMs`
against `nowMs()` cannot, and the caption is *derived* from it every frame rather than cleared by
a callback — so there is no expiry to get stuck.

### Why F14's own green run was green about a bug that was already in it

Worth recording, because it is the fourth probe in this milestone that could not fail for the
reason it claimed. F14's harness typed its code **once the client was already seated in the live
match** — and the only migration in a skirmish cycle happens on the way *into* that match. So no
entitlement in that run ever existed while a migration happened, and the probe could not have seen
one cross a boundary however broken the lifetime was.

`--cheats-early` types it in the arena instead. The generalisation, since this keeps happening:
**a probe has to be armed on the far side of the boundary it is testing**, and "when does this
probe fire relative to the event" is a question to ask before reading its output, not after.

### Measured

Every number came out of a run in this session. **No protocol change**: the frame layouts are
byte-identical — `MsgS.Cheats` is still an outcome and a mask, the owner block still carries one
byte — and the only wire-visible difference is that bit 4 is no longer a legal mask bit.
`NetClient` masks the incoming byte with `CHEAT_SIMULATION` on arrival, which now excludes that
bit by construction, so a frame carrying it is filtered rather than misread. That is why the
version is not bumped, and it is a decision rather than an omission.

**The lifetime, red before green.** `npm run skirmish -- --cheats --cheats-on --cheats-early` —
three clients, a real server, a real wire, shipped timings. One code each, typed in the **arena**;
the ballot then migrates all three into a live match. The red control is this tree with the one
line in `unseat` removed and the probe left alone.

| Probe | Red (the fix reverted) | Green |
|---|---|---|
| Entitlement ticks held **in an instance it was not granted in** | **37 028** of 44 220 | **0** of 7 214 |
| Tag ticks in an instance it was not granted in | **37 024** | **0** |
| Hits refused at the **live match's** damage door | **313** | **0** |
| The god client's live health floor / hits taken / deaths | 100 / 0 / 0 | 0 / 43 / 10 |
| The unseen client's live health floor / hits taken / deaths | 100 / 0 / 0 | 0 / 22 / 3 |
| The run | **FLOW CHECK FAILED**, twice | PASSED |

The red column is the whole report. Two clients typed a code in a room where neither code does
anything, and arrived in a live match invulnerable and unseen — 313 rounds refused for a cheat
nobody typed in that match, while the same three clients on the fixed tree took 43, 22 and 47 hits
and died ten, three and twelve times. The 44 220 denominator is printed next to the 37 028 on
purpose: a zero that means *"never held anything"* has to fail as loudly as a zero that means
*"never leaked"*. The red run was taken twice, at 37 024 and 37 028 ticks.

**The assertion inverts under `--cheats-early`, and it is written as a branch rather than
loosened.** Typed in the live match, the mask must be *held* and the door must refuse something,
or nothing was granted; typed in the arena, the identical numbers mean the opposite. The same
shape as F8's `--drop-hold 35000` run, and the first green run of this session failed all three of
the late-run assertions for exactly that reason before the branch was written. A check that
accepts either answer is a check that has stopped asking.

**F14's original run still passes**, which is the other half of the fix being correct rather than
just quiet. `npm run skirmish -- --cheats --cheats-on --clients 4`, codes typed in the live match:

| Client | Code | Mask | Live health floor | Hits taken (after the grant) | Deaths |
|---|---|---|---|---|---|
| OP1 | god | 2 | **100** | **0** (0) | **0** |
| OP2 | unseen | 4 | 1 | 7 (7) | **0** |
| OP3 | wallet | **0** | 0 | 33 (0) | 7 |
| OP4 | — | 0 | 0 | 25 (0) | 6 |

with **102 hits refused** at the damage door and **0** of 37 016 entitlement ticks outside the
instance the codes were typed in. OP3's mask is 0 where F14 measured 16, and that is the model change: an
instant cheat holds no entitlement, so there is no bit for anything to leak.

**The rest of the gate, unmoved.** Nothing in this session may touch a match with no cheats in
it, and nothing did.

| Probe | Result |
|---|---|
| `npm run skirmish`, standing, no flags | **FLOW CHECK PASSED** — divergence **0 / 7374** per client, mispredictions into a live match **0** (spawn window 0), spectator 6440 picks **0 self / 0 enemy / 0 dead**, quick loadout 10 024 ticks over 31 windows **0 while alive**, Tab 3188 of 6441 dead ticks, per-life stock 114 life-starts (26 human, 88 bot) **0 partial / 0 empty**, 280 grenades against 280 expected, arena health floor **100** over 125 hits |
| `npm run harness`, 5 matches, seeds 1-5 | Scores **75-59, 75-66, 62-75, 75-66, 60-75** — byte-identical to P5/P9/P6/P8 and to F14 on the same seeds. `partialStock` **0** in all five, `dirtyLifeStarts`/`roundCarryOvers` **0 / 0** in all five, `credited` **0** in all five |
| `npm run leak`, 100 cycles | subscriptions **29 → 29 (+0)**, heap 13.02 → 13.71 MiB (+0.69). **LEAK CHECK PASSED** — the baseline is unchanged, because removing a bit and clearing a `Map` entry subscribes to nothing |
| `npm run check` and `npm run build` | boundaries (297 files), the cosmetic audit (19 snapshot fields), the optic audit, the unlock audit and the cheat audit (**6 codes, 4 entitlement bits** — one fewer than F14, and the partition still disjoint and complete) all pass, and all three typecheck targets |

The cheat audit's bit count going 5 → 4 is the model change showing up in the gate, which is the
sort of thing an allowlist-shaped check is for.

### What was not verified

**The caption itself, which is the half that was reported.** `Game` raises it from a wall-clock
deadline and `HeadlessClient` has no `Game`, so `instantCheatLabel` is always `''` in every number
above — every tag tick counted is a **toggle** tick. That is stated as a limit in the code rather
than left to be discovered: the four seconds, the composition with a standing `GOD`, and the fade
are all browser claims.

What the harness does prove is the part that was dangerous: the entitlement no longer crosses a
migration, on the server, where the effect lives.

Also unverified, and reasoned from the code:

- **That `onMigrated` drops the caption** — the call is one line beside three that were already
  there, and no headless run builds a `Game` to reach it.
- **`MO951357` in single-player**, which takes the local branch and raises the caption without a
  server round trip at all.

### Needs a browser

- **The regression itself, and it is the one to check first.** With `CHEATS_ENABLED=1`: join the
  arena, pause, type `SPEC[]1`, resume. Wait for the ballot to migrate you into a match. On
  arrival the tag must be **gone** and you must be mortal — stand in front of a bot and confirm
  you take damage. Then pause and type `SPEC[]1` again *in the match*: now it must stick.
- **The caption's four seconds.** In a live match, type `MO951357`. The tag must read
  `CHEATS · +30 KILLS`, and must be gone about four seconds later while the balance stays up by
  30. Type it twice in quick succession: the caption restarts rather than stacking, and the
  balance goes up by 60.
- **The composition.** Type `SPEC[]1`, then `MO951357`. It must read `CHEATS · GOD · +30 KILLS`
  and then fall back to `CHEATS · GOD` — the standing warning must not disappear with the
  announcement.
- **`DEBUG666` must survive the migration.** Unlock it in the arena, get migrated, and the pause
  screen's Debug overlay button must still be there. This is the row that is deliberately *not*
  cleared, so it is the one that would break if the client half were written as "clear
  everything".
- **The caption does not cross a migration.** Type `MO951357` in the arena a second or two before
  the ballot resolves, so the announcement is still up when you migrate. It must go with the
  migration rather than finishing its four seconds in the new match.
- **Free cam across a migration.** `SPEC[]3` in the arena, then migrate: you must land on the
  floor, in collision, not flying. Watch for one correction at the boundary and no more.

Unchanged from the earlier lists: the arena-return residual of 1-3 sub-25 cm mispredictions, and
everything under "Open, and all of one kind".

### Found while here

- **`unseat` is the only door out of a seat, and it had no list.** `releaseEntity`,
  `encoders.delete`, `seats.delete` and now the entitlement clear are four things that must all
  happen there, and nothing enumerates them — a fifth piece of per-seat state added next
  milestone will be forgotten the same way this one was. The `Session` fields are the other half
  of the same gap: `loadout`, `reconnectToken` and `cheats` all live there with three *different*
  lifetimes and nothing says which is which except prose. Recorded rather than restructured,
  because the fix is a decision about where per-seat state should live rather than a line.
- **`Cheat.Debug` has never been exercised by any headless run.** The server never grants it, so
  `cheatMask` is always `CHEAT_SIMULATION`-only in the harness and `debugUnlocked` is always
  false there. Every number about the debug overlay's gate is therefore reasoned rather than
  measured, and that was true in F14 as well — it is on the browser list above and has been on the
  previous one.

## Playtest round 4 — a bar with nothing left to cross, and two facts that were spreading

Three regressions, and only one of them is a defect somebody wrote this round. The other two are
P6's own shapes propagating, which is the more useful half of the session: both were correct
where they were written and wrong as soon as a second thing needed the same fact.

### The XP bar never finished, and it is M9 code that P2 made survivable

*The symptom exists because `XpSummary.stepBar` computed its own span as
`Math.max(1, xpForLevel(level))`, and `xpForLevel` returns **0** at the cap on purpose.* That
`max(1, …)` invented a one-XP level above level 55. `nextLevelAt` therefore landed *below* the
target, so every frame "crossed" it, replayed the flourish for a level that never changed, and
put the bar back just under the line it had already passed. `phase` never reached `DONE`, and
`XpSummary`'s own `requestAnimationFrame` loop stops on `DONE` and nothing else.

**Which of the two mechanisms it is, since they sound the same.** It is the loop, not a pooled
voice that is never released, and that was settled by reading the pool rather than by guessing:
`AudioGraph.oscHit` copies the spec into the voice synchronously and sets
`endsAt = now + decay + 0.05`, and `AudioGraph.update` runs once a frame and releases every
voice past it. Nothing can hold a voice open. The sound repeats because something replays it.

**On the provenance, the file history does not support blaming a round-4 session.**
`git log -S "Math.max(1, xpForLevel(level))"` puts the line at `939e7d4` (M9), and neither
`XpSummary.ts` nor `Levels.ts` has been touched by any session in this round. What changed is the
screen's *lifetime*. Before **P2** the client stopped servicing its socket the moment the board
appeared, the server closed the connection ten seconds into a fourteen-second hold, and the
player was dropped to the main menu — which runs `hideSummary()` and with it `xpSummary.stop()`.
The loop was cut off by a disconnection before anybody could name it. P2 made the board survive
its full hold with a live connection, and a defect that used to be interrupted now runs to the
end of the screen. The round's other work supplies the state that triggers it: B7 and F1 both
turn on account level, and the way a tester reaches a level is `SaveInspector.grantXp`.

The guard is the general one rather than the max-level one, and that distinction is the fix.
`stepLevelBar` in `shared/meta/Levels.ts` owns the decision now — advance, hold, or stop — and it
stops when **the next boundary is not ahead of where the bar already is**. Reaching the cap is one
way to be in that position, because `span` is genuinely zero there. A report already at its target
is another, and it needs no separate early return: the same comparison answers both. `XpSummary`
keeps the DOM, the flourish and the frame loop and no longer does any arithmetic.

### The room's rules were spreading as a bare id comparison

*The symptom exists because P6 took the arena's score **data** away and left its **surfaces**.*
`ScoreSystem.records = false` means the room registers no rows, and the score banner, the Tab
board and the streak strip all went on painting from nothing: the banner fell back to the literal
string `LEADER` with two zeroed bars, Tab opened on an empty board, and the streak strip counted
toward a kill that cannot happen there. A ladder showing zeroes is still a ladder, which is what
F7 asked to have taken out of the waiting room.

The second half is the shape rather than the bug. P6 derived "am I in the arena" as
`server.welcome.matchId === WARMUP_MATCH_ID` in `MatchWorld` and threaded it as a constructor dep
into `ClientMatch` and again into `MatchHud`, where `matchCaption` and `captionHasCountdown` took
it as a loose boolean. P10 then copied the pattern for `briefVisible`. Three functions, one bare
comparison, and every new surface obliged to remember it — which is a rule that fails by
*omission*, and an omitted comparison looks like nothing at all in a diff.

Three changes, and the third is the one that generalises:

- **The fact belongs to the instance kind.** `MatchInstance.isArena` is abstract and declared by
  the two subclasses: `WarmupMatch` is the arena because of what it is, not because of the id it
  holds. The id exists so a *client* can name the same instance on the wire.
- **One comparison in the project.** `isArenaInstance(matchId)` in `shared/net/Skirmish.ts` is
  now the only place `WARMUP_MATCH_ID` is compared against outside a debug label, and the
  harness's seven scattered copies were routed through it in the same pass.
- **One predicate, and every result surface reads it.** `inWarmupArena` moved into
  `HudSurfaceState`, and `resultSurfacesVisible` decides the banner, the board and the streak
  strip together. They are grouped rather than given a predicate each because they are three
  views of `ScoreSystem`, which is the object F7 switched off — they fail and succeed together.
  `Game.updateHudSurfaces` evaluates it once a frame beside every other surface rule and pushes
  the answer down, so nothing inside the HUD asks the question at all.

The rule is deliberately *not* "hide the board when it is empty". That is a second way of saying
the same thing, it goes wrong the first time a room legitimately holds a row, and it is a rule
each surface would have to implement for itself. It is: **this instance keeps no record, so
nothing that displays one is up.** The caption is pointedly outside the group — it is the one
surface the room adds rather than removes.

Both new `[hidden]` rules in `hud.css` are required rather than defensive, and for the reason
B13 established: `hidden` hides an element only because the UA stylesheet says
`[hidden] { display: none }` at the lowest specificity there is, and `.hud-banner`'s
`display: grid` and `.hud-streaks`' `display: flex` both outrank it.

### One edge over the ballot phase, and the mode ballot was silent

*The symptom exists because P6 wrote the edge detector as `mapBallotOpened` — literally
`next === MAP_VOTE && previous !== MAP_VOTE`.* P6 chose that to make "one cue per cycle" a clean
assertion, and it bought the assertion by leaving the **mode** ballot silent: the first ballot,
the one that opens the whole twenty-second question while the player is mid-firefight, arrived
with no cue at all. The cue was missing exactly where it was most needed.

`ballotOpened(previous, next)` replaces it and returns *which* ballot opened, or `null`. The rule
is a property of the phase machine rather than of either ballot: a ballot has opened when the
phase becomes a ballot it was not already, so `PLAY -> MODE_VOTE` and `MODE_VOTE -> MAP_VOTE` are
both openings and the forty broadcasts inside either one are not. One detector, not two — a
second copy beside the first is how the trap gets fixed twice and diverges once.

**Mode and map sound different, from one generator.** They are two stages of one question, so the
cue should be recognisably the same event and distinguishable without looking up from the fight:
`playBallotOpen` takes the phase and pitches the same two-note rising figure from it, the map a
fourth above the mode. The second cue says *the mode is settled, the map is the question now*.
Two separate sounds would have to be designed against each other and would drift.

Fixed in the same pass, and it was P6's too: the second note was delayed with `attack = 0.14`,
which fights the pool. `oscHit` schedules the voice's release from `decay` alone
(`endsAt = now + decay + 0.05`, `osc.stop(now + decay + 0.02)`), so an attack that long is an
envelope the voice is recycled out from under. `oscHit`'s own `delay` argument is the mechanism
this file already has for a multi-part sting, and it moves the whole voice onto the audio clock.

### Measured

Every number came out of a run in this session. **No protocol change** — nothing here touches the
wire, and the arena fact was already on it as `Welcome.matchId`.

**`npm run progression` — the new probe, and the reason the bar is now checkable at all.** A
summary that never finishes its animation is invisible to every instrument this project has:
`HeadlessClient` builds no `ClientMatch` and no DOM, the skirmish harness at shipped timings has
never once reached a summary, and the preview pane never fires `requestAnimationFrame`. Moving
the decision out of `XpSummary` is what makes it an ordinary function call with an ordinary
answer.

| Case | Steps | Level-ups |
|---|---|---|
| Level 1, no XP earned | 1 | 0 |
| Level 1, half a level | 27 | 0 |
| Level 1 -> 2, exactly one level | 68 | 1 |
| Level 1 -> 4, three levels | 200 | 3 |
| Mid-curve, level 30 -> 31 | 68 | 1 |
| The whole curve, level 1 -> 55 | **3 566** | 54 |
| **At the cap, earning more** | **1** | **0** |
| At the cap, a match worth nothing | 1 | 0 |
| Level 54 -> 55, then past it | 68 | 1 |

**The red control is kept, permanently, and it is the half that makes the probe an instrument.**
`runBarLegacy` is the pre-fix arithmetic verbatim, run on the max-level case: **it did not
terminate in 36 000 steps and produced 35 934 boundary crossings.** The count is crossings and not
flourishes — on screen each one sets `phase = 'LEVELUP'`, which holds 0.85 s before handing back,
so the player hears roughly one a second rather than one a frame. What the number establishes is
the thing the pacing hides: there is no last crossing. If a future change to the level table ever
makes that version terminate, the run says so and fails, because a control that cannot go red is
not controlling anything.

**`npm run skirmish` — 3 headless clients, a real server, shipped timings.**

| Probe | Result |
|---|---|
| Result surfaces up in the room | **0 ticks** — and **55 280** in a live match, which is the control that proves the probe can see them |
| Ballot cue, per client per cycle | **2** — one per ballot opening — against **86** broadcasts that a level-triggered cue would have fired on |
| Arena score rows / health floor / deaths in the room | **0** / **100** over 24 hits taken / **0** |
| Caption in the room / `WAITING` in a live match | 10 818 ticks / **0** |
| The run | **FLOW CHECK PASSED**; 3 of 3 migrations, 0 failed |
| Mispredictions entering a live match | **0** (S8.9 requires 0); spawn window 0 |
| Divergence checker | **0 / 7369** per client |
| Spectator invariants | 7012 selections while dead, **0 self / 0 enemy / 0 dead** |
| Quick loadout window | 10 279 ticks over 31 windows, **0 while alive** |
| Per-life grenade stock | 109 life-starts, **0 partial / 0 empty**, 274 held against 274 expected |

**`npm run harness` — 5 matches, seeds 1-5, TDM on Foundry.** The regression control:
**75-59, 75-66, 62-75, 75-66, 60-75**, byte-identical to the standing baseline. Nothing in a live
match moved, which is the claim every change here has to be able to make.

**`npm run leak` — 100 cycles.** Subscriptions **29 -> 29 (+0)**, heap 13.03 -> 13.72 MiB (+0.69).
**LEAK CHECK PASSED.**

**`npm run check`** and **`npm run build`** green — boundaries (298 files), the cosmetic, optic,
unlock and cheat audits, and all three typecheck targets.

### What was not verified

- **That the bar looks right at the cap.** What is measured is that it terminates in one step and
  fires no flourish. Whether an instant jump to a full bar reads as finished or as broken is a
  frame, and the probe has no opinion about it. It is the first thing on the browser list.
- **Both ballot cues.** The rate is measured; the sound is not, because `ProceduralAudio` needs an
  `AudioContext` and the harness has none. Whether a fourth is far enough apart to tell the two
  stages apart mid-firefight is a question for ears.
- **That the HUD actually goes down in the arena.** 0 ticks says the *rule* is never true there
  and the 55 280 says the rule can be true; neither says a pixel was hidden. The two new
  `[hidden]` rules are exactly the class of thing that compiles and does nothing, which is what
  B13 was.

### Needs a browser

- **The XP bar at the cap, and it is the one to check first.** Grant yourself past 676,400 XP in
  the save inspector, play a match, and watch the summary to the end. The bar must fill, the total
  must land, and the tail must appear — **once**. No `LEVEL 55` flourish, and no repeating chime.
  Then do the same at level 3 with a normal match: the flourish must still play on the level-up
  and the bar must still stop on the boundary, because that is the behaviour the fix must not have
  cost.
- **The waiting room's HUD.** In the arena there must be **no score banner at the top of the
  screen, no streak strip at the bottom left, and Tab must open nothing at all** — not an empty
  board. The `WAITING` caption must still be there, centred, with no number beside it. Then vote
  into a match: all three must come back on the same frame the world does, and the caption must be
  gone.
- **Both ballot cues, in one cycle.** Stand in the arena through a full sixty seconds. One cue as
  the mode ballot opens, a second and higher one as the map ballot replaces it, and **nothing** in
  the ten seconds either ballot is up. Check both are audible over sustained fire.
- **The second note.** It should read as two notes rather than one; if it sounds clipped, the
  delay and the decay are the two numbers, and `oscHit`'s release schedule is what they have to
  agree with.

Unchanged from the earlier lists: everything under "Open, and all of one kind".

### Found while here

- **`XpSummary` drives its own `requestAnimationFrame` loop and stops on one condition.** Nothing
  outside it ticks the animation — `EndOfMatch` has no `tick` any more, and `Game` only pushes the
  countdown — so `phase === 'DONE'` is the sole exit, alongside `stop()` and `finish()`, both of
  which are tied to a button press. Any future phase that can fail to reach `DONE` is a loop that
  runs until the player clicks something, and there is no supervisor above it to notice.
- **The arena fact now has three names and they are deliberately different.**
  `MatchInstance.isArena` is the instance kind on the server, `isArenaInstance(matchId)` is the
  one comparison a client can make, and `HudSurfaceState.inWarmupArena` is the per-frame record
  every surface rule reads. They are separate because they answer at different levels; what must
  not happen again is a fourth one spelled out inline.
- **`AudioGraph` releases voices on `decay` and ignores `attack` entirely.** That is fine for
  every sound in the project except one that tries to use a slow attack as a delay, which is what
  P6 did. `oscHit(spec, delay)` exists for that and is the only correct way to schedule a second
  note. Worth knowing before the next multi-part cue.

## Playtest round 4 — one fact in two places, twice, and a toggle asked to mean "off"

Two reports from a browser session against the F14 fix above. The transient wallet caption is
correct and stayed correct; these are both new, and they turn out to be the same mistake made
twice in one feature.

**One sentence each.**

1. *"Typing `DEBUG666` opens the overlay. Closing it with its own × and typing the code again
   prints 'code cleared' and a third press is needed to reopen."* — `Cheat.Debug` and
   `debugRequest` were two representations of one fact, and the × writes only one of them.
2. *"Activate `SPEC[]1` alone, migrate, and arrive in the next match with `SPEC[]4` — all three
   cheats — on. Activate `SPEC[]4` and migrate, and it clears correctly."* — the client's world
   teardown expressed *"turn everything off"* as a **toggle** of the three-bit set, and a toggle
   of a set completes the set from every mask that does not already hold all of it.

### 1 is round four's B1, reintroduced by the session that quoted B1

B1's own description, from earlier in this file: *"two copies of 'is the debug overlay open', and
the × wrote one of them."* Its fix was one value instead of two — the `debugRequest` tri-state.

F14 then added a second copy, and argued for it explicitly: *"it is a **second** fact and not a
restatement of `debugRequest` … *may they* and *do they want it, and from where* are different
questions."* That argument is wrong, and the way to see it is to list the writers:

| Writer | wrote `Cheat.Debug` | wrote `debugRequest` |
|---|---|---|
| the code, `DEBUG666` | yes | yes |
| the pause menu's button | — | yes |
| resume's demotion `onPause → inMatch` | — | yes (stays non-none) |
| **the × / Escape** | **no** | **yes → `'none'`** |

Every writer of the bit also wrote the request, so the two were always equal — except in the one
row where only the request was written, which is the × dismissing the panel. There the bit said
"unlocked" over a closed panel, the code's next press read as a revoke, and it took a third press
to reopen. A fact that is only ever written together with another fact is not a second fact; it is
a copy, and P0 bans exactly this shape.

So the bit is deleted. `debugUnlocked` derives — `debugRequest !== 'none'` — and
`debugOverlayVisible` is back to the expression P1 shipped, which is the strongest evidence
available that the extra term never carried anything. `DEBUG666` writes the request and nothing
else, and it toggles against **what is on screen**: `debugOverlayVisible(hudSurfaceState())`. Up,
the code takes it down; down, the code puts it up. The pause menu's button remains gated on the
same derivation, so it appears with the panel and goes with it.

**A consequence worth stating rather than discovering:** the debug overlay is now reachable only
while `debugRequest` is non-none, which after a × means retyping the code. That is what the report
asks for — the second press must reopen — and it is what F14's own brief asked for when it said
the overlay *"becomes reachable only through the entitlement"*.

### 2 is arithmetic, and here is the arithmetic

`toggleCheat` is the only verb the codes have:

```ts
const all = (mask & bits) === bits;
return all ? mask & ~bits : mask | bits;
```

Read it with `bits = God|Unseen|NoClip = 14`:

| `mask` | `(mask & 14) === 14` | result |
|---|---|---|
| `0` | no | **14** — all three |
| `2` (god) | no | **14** |
| `6` (god+unseen) | no | **14** |
| `14` | yes | `14 & ~14` = **0** |

**Only the full mask clears. Every other mask widens to the full set.** That is correct for a
toggle — it is `SpectatorPanel`'s documented "complete the set unless it is already complete" —
and it is catastrophic as a way of saying *"off"*, which is a **state** rather than a relative
move. The two coincide at exactly one input, and that one input is why the report saw `SPEC[]4`
behave correctly: 14 toggled by 14 is 0.

The `~` the report suspected is real and is in that first branch. It is not misplaced: the flaw is
that a caller wanting a state reached for a verb that expresses a difference.

**The caller.** `Spectator.full(false)` was one request for that code, and `DebugSuite.dispose()`
called it through `spectator.reset()` — a line predating F14, whose comment called it
belt-and-braces against *"a spectator flag surviving into the next match"*. That was true when
this class owned three booleans and `reset()` wrote them to `false`. F14 turned them into
**requests**, and the line silently became a cheat request sent during teardown.

**And the timing is what put it in the *next* match.** `applyRotation` — shared by rotations and
migrations, deliberately — calls `teardownWorld` *after* the server has already re-seated the
player, and the previous session made `MatchInstance.unseat` clear the seat's mask. So the chain
is:

1. the ballot resolves; the server unseats (mask → **0**), seats the player in the live match;
2. the client receives `Migrate`, and `applyRotation` tears the old world down;
3. `DebugSuite.dispose` → `Spectator.reset()` → `full(false)` → one request to toggle all three;
4. the server applies it to the **new** seat's mask of 0: `0 | 14` = **14**.

A player who typed one code arrived holding three, and the thing that granted them was the code
path whose comment said it was there to take cheats *away*. Note that the previous session's clear
is not the cause — before it the request landed on `2` and produced 14 just the same — but it is
what makes the outcome read as *"`SPEC[]4` activated in the new match"* rather than *"my cheat
followed me"*.

### The fix: a verb that means "off", and a teardown that writes nothing

`bitsClearing(mask, bits)` returns **one single-bit toggle per bit that is actually set**. Correct
from any mask, and the only thing expressible — a toggle is the whole input model of this feature,
and adding an absolute "set this mask" door is precisely what would let a client author an
entitlement. Multi-bit codes are never part of the answer, because a multi-bit code is the thing
that cannot express "off".

`Spectator.full(false)` folds over it. And **`DebugSuite.dispose` no longer resets anything**: the
entitlement's lifetime is the seat, the server ends it at `unseat`, and every effect is derived
from the replicated mask every tick — so a torn-down world holds no cheat state to leak and there
is nothing to undo. The absence is load-bearing and the comment there says so, because after F14 a
"reset" is a *request*, and a request during teardown is a write to state this process does not
own.

### What the two reports have in common, and it is the thing to carry forward

Both are a **second representation of one fact**:

- a bit beside `debugRequest`, and one writer of the pair;
- a relative verb standing in for an absolute state, agreeing with it at one input out of eight.

The second is the more interesting because nothing about it looks like duplication. `full(false)`
reads as "the off half of a boolean setter" and is actually "a toggle that happens to coincide with
off in one case". The generalisation: **when a setter takes a boolean and the mechanism underneath
it is a toggle, the two halves are not symmetrical, and the asymmetric one is the one nobody
tests** — the report's own observation that `SPEC[]4` "correctly clears" is exactly the symmetric
case working and hiding the other seven.

### Bits removed, and what that simplified

`Cheat.Debug` is the second bit to leave the table since F14, after `Cheat.Wallet`, and for the
same reason: neither was a state a player could be *in*. What is left is the three the simulation
actually reads, **all server-authored**, which collapses `Game.cheatMask` from a two-authority
merge to one expression:

```ts
return (net === undefined ? this.offlineCheats : net.cheatMask) & CHEAT_SIMULATION;
```

`CHEAT_LOCAL` is gone with the bit it held. `CheatCode.local` is gone too — it meant the same
thing as the new `kind: 'surface'`, and two spellings of one property is the mistake this whole
section is about. `DEBUG666` is `kind: 'surface'`: no bit, never sent, and the store it writes is
the one that already owns that surface.

`localCheats` is `offlineCheats`, because with no client-authored bits left it holds simulation
bits and nothing else. It is cleared in `teardownWorld`, which is the **offline** mirror of
`MatchInstance.unseat` — without it a single-player god mode would follow the player through the
menu into their next match, which is the networked defect the previous session fixed, one runtime
over.

### The check that was written, watched red, and found to be worthless

`check-cheats.mjs` got the exhaustive clearing property first. It cannot import TypeScript, so it
re-implemented `bitsClearing` in JavaScript from the bit table — and when the real function was
broken back to a single multi-bit toggle, the check **stayed green**. It was proving a property of
its own copy.

That is the fifth probe in this milestone that could not fail for the reason it claimed, and it is
the first one that was mine and caught in the same sitting. The proof moved to
`assertClearingArithmetic` in `skirmishHarness.ts`, which is compiled and imports the real
functions, and which runs **unconditionally at the top of every harness invocation** rather than
behind `--cheats` — the regression it guards shipped because the only probe touching cheats had to
be asked for.

What `check-cheats.mjs` keeps is what a regex can honestly enforce, and it gained one rule that
replaces the deleted `local` flag: **a `'surface'` code may not carry entitlement bits.** That is
the security property in one line — a bit on a client-applied code is a bit a client can author.

### Measured

Every number came out of a run in this session. **No protocol change**: layouts are byte-identical
and the retired bit is filtered by `CHEAT_SIMULATION` on arrival rather than misread, which is the
second time that mask has absorbed a removal.

**The arithmetic, red before green.** The red control is the real `bitsClearing` with its
single-bit guard removed — i.e. "off" expressed as one multi-bit toggle, which is what shipped.

| Probe | Red | Green |
|---|---|---|
| Reachable masks `bitsClearing` fails to clear | **7 of 8** | **0 of 8** |
| `SPEC[]1` alone, cleared | **14 (god+unseen+noclip)** | **0** |
| `SPEC[]4`, cleared | 14 | 0 |
| The run | **FLOW CHECK FAILED**, 8 ways | PASSED |

The red column is the report: *"clearing god mode alone gives 14 (god+unseen+noclip), not 0 — this
is the reported mutation: a single active cheat becoming the full set."* Mask 14 fails in the red
run too, and for a reason worth reading — with the single-bit guard gone the answer includes the
three-bit code itself, so the fold ends where it started. The one mask that behaved in the browser
is the one the browser never exercised through this path.

**The seat lifetime, still holding.** `npm run skirmish -- --cheats --cheats-on --cheats-early`,
three clients, codes typed in the **arena**, migrated into a live match:

| Probe | Result |
|---|---|
| Codes typed / answered / granted | 3 / 3 / 3 |
| Mask after the migration, per client | **0 / 0 / 0** |
| Hits refused at the live match's damage door | **0** |
| Entitlement ticks in an instance it was not granted in | **0** of 7212 held |
| Live health floor / hits / deaths, per client | 0 / 23 / 6 · 0 / 18 / 4 · 0 / 29 / 7 |
| The run | **FLOW CHECK PASSED** |

**And codes typed inside the match still work**, which is the half a lifetime fix can quietly
break. `--cheats --cheats-on --clients 4`:

| Client | Code | Mask | Live health floor | Hits (after grant) | Deaths |
|---|---|---|---|---|---|
| OP1 | god | 2 | **100** | **0** (0) | **0** |
| OP2 | unseen | 4 | 62 | 1 (1) | **0** |
| OP3 | wallet | 0 | 0 | 33 (0) | 6 |
| OP4 | — | 0 | 0 | 19 (0) | 5 |

**98 hits refused** at the damage door, **0** of 37 015 entitlement ticks outside the instance the
codes were typed in.

**The rest of the gate, unmoved.**

| Probe | Result |
|---|---|
| `npm run skirmish`, standing | **FLOW CHECK PASSED** — divergence **0 / 7373** per client, mispredictions into a live match **0** (spawn window 0), quick loadout 8858 ticks over 26 windows **0 while alive**, Tab 2602 of 5273 dead ticks, per-life stock 112 life-starts (22 human, 90 bot) **0 partial / 0 empty**, 268 grenades against 268 expected |
| `npm run harness`, 5 matches, seeds 1-5 | Scores **75-59, 75-66, 62-75, 75-66, 60-75** — byte-identical to P5/P9/P6/P8 and to both F14 sessions on the same seeds. `partialStock` **0** in all five, `dirtyLifeStarts`/`roundCarryOvers` **0 / 0** in all five, `credited` **0** in all five |
| `npm run leak`, 100 cycles | subscriptions **29 → 29 (+0)**, heap 13.05 → 13.73 MiB (+0.68). **LEAK CHECK PASSED** — deleting a bit and a teardown call subscribes to nothing |
| `npm run check` and `npm run build` | boundaries (298 files), the cosmetic audit (19 snapshot fields), the optic audit, the unlock audit and the cheat audit (**6 codes, 3 entitlement bits**, all server-authored) all pass, and all three typecheck targets |

### What was not verified

**Both reports are browser reports, and neither symptom is reachable headlessly.**

- The `DEBUG666` desync is entirely a client surface: `HeadlessClient` builds no `Game`, never
  grants the debug request, and has no × to click. `debugUnlocked` is a one-line derivation now
  and it is *reasoned*, not measured.
- The mutation's **trigger** is `DebugSuite.dispose`, which no headless run reaches. What the
  harness proves is the arithmetic underneath it — exhaustively, against the real function — and
  that no entitlement crosses a migration. The path from a torn-down world to a request on the
  wire is a browser claim.

Also unverified: that removing the teardown reset leaves nothing behind in single-player, where
`teardownWorld` clearing `offlineCheats` is the only thing that ends an offline cheat.

### Needs a browser

- **Report 1, and it is two presses.** `CHEATS_ENABLED` irrelevant — this works offline. Pause,
  type `DEBUG666`: the overlay opens and a "Debug overlay" button appears. Click the panel's **×**:
  panel and button both go. Type `DEBUG666` **once**: it must open again. Not twice.
- **Report 1's other closer.** Same, but close with **Escape** instead of the ×, and confirm one
  press of the code reopens it and that Escape did not also drop you onto the pause screen.
- **Report 2, the exact sequence.** `CHEATS_ENABLED=1`. In the arena, pause, type `SPEC[]1`,
  resume. Wait for the ballot to migrate you. In the new match: **no tag at all**, and you are
  mortal. Specifically confirm the tag does not read `CHEATS · GOD · UNSEEN · NOCLIP`.
- **Report 2, the case that used to work.** Same with `SPEC[]4` in the arena — it must still clear
  to nothing on migration, which it did before and must not have regressed.
- **The QA panel's "toggle full spectator", both directions.** Tick god mode alone, then press
  the headline button: it must complete the set. Press it again: all three must clear. Then god
  mode alone again and press **off** through the console (`__operator.spectate.off()`): god must
  clear and the other two must stay off — not come on.
- **Single-player cheat lifetime.** Offline, `SPEC[]1`, quit to the menu, start a new match: you
  must be mortal.
- **The debug overlay across a migration.** `DEBUG666` in the arena, get migrated: the overlay
  must still be up, because its lifetime is the session and not the seat. This is the row that
  would break if the deleted bit had been replaced with a blanket clear.

Unchanged from the earlier lists: the arena-return residual of 1-3 sub-25 cm mispredictions, and
everything under "Open, and all of one kind".

### Found while here

- **`Spectator.reset()` now has exactly one caller** — `__operator.spectate.off()` — and it is a
  method whose only remaining purpose is a console convenience. Left, because the console surface
  is documented in DEBUG.md and a QA tool losing its one-liner is a real loss; but it is worth
  knowing that the dangerous caller was the one nobody typed.
- **`toggleCheat`'s widening is now documented in the function itself**, with the table above, and
  the harness asserts it still widens. That is deliberate: a caller reasoning about `full(false)`
  needs to know the primitive is asymmetric, and a future change that made `toggleCheat` clear
  from a partial mask would silently make `bitsClearing` redundant while looking like a
  simplification. The assertion fails if that happens, so the reasoning gets re-read.
- **`CheatBit` is now an exported type with no importer.** It described the bit union and every
  reader takes a plain `number`, because masks are combinations rather than single bits. Not
  removed here — it costs nothing and names something real — but it is the kind of export that
  looks load-bearing and is not.

---

## Playtest round 4 — one rule about a life, replaced by two about time

Nothing here was reported and nothing here was broken. B10 shipped, worked, and was measured
working — *"killstreaks became a currency, and the first rule that bounded it"*, earlier in this
file, records a permanently funded wallet, a peak balance of 32 against a price of 4, and no life
that ever bought the same UAV twice. This session takes that rule out on purpose. It is an architectural override, so the first job was to find every place that assumed
the rule and change the record as well as the code.

### Why a per-life cap was the wrong axis

P4's argument for once-per-life is in that section and it is right about the danger: under
a pure balance, twelve kills buys the same four-kill UAV three times and the optimal play is to
spam the cheapest thing in the class. What it gets wrong is where the danger lives. "Three UAVs
off twelve kills" is a complaint about **pace** — three in quick succession — and a per-life cap
answers it by removing the possibility altogether. A player who goes on to earn the price a
second time over the following two minutes gets refused for a reason that has nothing to do with
the two minutes, and the rule is invisible to them in the moment: the strip said `USED` and the
only thing that would clear it was dying.

So the cap comes off and three mechanics take its place, none of which is new state beside the
wallet:

1. **The price is charged again.** Already true — `charge` debits every activation and always
   has. Re-using a streak means earning it again, in the same life.
2. **A per-streak cooldown of 30 s**, from the moment that streak's *effect* ends. Other streaks
   are unaffected, so keys 4 and 5 back to back is fine and key 5 twice is not.
3. **No two of the same at once.** A streak whose previous instance is still in the world cannot
   be called in again.

### The three decisions, made rather than defaulted

- **Death.** The wallet zeroes, which is P4's rule and stands. **The cooldowns do not** — they
  run on the sim clock and a life boundary is not a moment in it. A player who could shorten a
  wait by dying would have a reason to die, which is the opposite of what a killstreak is for.
  That decision is the one line in `StreakLedger.resetLife` that leaves a field alone, and
  `cooldownsCrossingDeath` is it counted rather than asserted.
- **Concurrency.** The key is refused and the strip shows the same state a cooldown shows,
  because to the player the two are one event: nothing happened, and here is how much longer
  that will be true for. `lockoutTicks` is the one number both produce; only the log distinguishes
  them, through `refusedLive` and `refusedCooling`.
- **The clock starts when the effect ends.** So a lasting streak's real lockout is its own
  duration plus the thirty seconds — a UAV is 60 s from the press, a sentry 120 s — and a mortar
  or a care package is 30 s flat.

### Every streak needed an "effect ended" moment, and it is not `durationSeconds`

`StreakDef.effectEnds` is `'activation'` or `'expiry'`, on the definition rather than in a
`switch` the seventh streak would fall through:

| Streak | `durationSeconds` | `effectEnds` | Lockout from the press |
|---|---|---|---|
| UAV | 30 | expiry | 60 s |
| Counter-UAV | 25 | expiry | 55 s |
| Care package | 60 | **activation** | 30 s — plus the crate, while it is down |
| Mortar strike | 14 | **activation** | 30 s |
| Sentry gun | 90 | expiry | 120 s, or less if it is destroyed |
| Chopper gunner | 32 | expiry | 62 s |

Deriving it from the duration would have been wrong for exactly the two streaks the brief named.
A care package's sixty seconds is how long an *unclaimed crate* is left on the floor, and a
mortar's fourteen is how long the barrage takes to finish falling; neither is a stretch of time
the owner is getting anything out of, and reading a duration as if it were would have priced two
streaks by a number that means something else in both.

The cooldown is armed twice and it is the same call both times. `activate` arms an **estimate** —
`effectEndTicks(def) + 30 s` — so the strip is honest about the whole wait from the first frame
rather than jumping when the streak expires; `retire` **replaces** it with the fact, for
`'expiry'` streaks only. The two agree when a streak ran its full duration and the fact is
earlier when it did not, so a sentry shot down at ten seconds is buyable again at forty rather
than at a hundred and twenty. An `'activation'` streak is deliberately not re-armed on retire: an
unclaimed crate expiring sixty seconds later must not restart a cooldown that ran out thirty
seconds ago.

### Dying shortens exactly one wait, and that is a decision

`retire` is the single exit every streak leaves the world through, §8.23's four Chopper Gunner
cases included — and two of those four are a **death**: `onDeath` retires a gunner shot out of
their own body, and `onOwnerRemoved` brings a disconnecting gunner's chopper down with them.
Under "the clock starts when the effect ends", that destruction *is* the effect ending, so the
thirty seconds start there.

The consequence, stated because it is the one case where dying makes a wait shorter: a gunner
killed at second 5 of a 32-second flight can buy the chopper again 27 seconds earlier than one
who flew it out. That is left as it is, for two reasons. It is the honest reading of the rule —
the chopper stopped shooting, so its effect is over — and any other reading needs a second clock
that keeps running for a streak that no longer exists. And the shortcut is worthless in practice:
dying also zeroes the wallet, so the player has to re-earn twelve kills before the cooldown is
what is stopping them, and twelve kills takes considerably longer than 27 seconds. **The cooldown
almost never binds across a death; it binds inside a life, which is what it was added to do.**

### `dirtyLifeStarts` was never the grenade probe

Asked for by call site, and the answer is that the name was misleading rather than the code. It
is declared in `StreakLedger`, written by `noteLifeStart` (subscribed to `EV.PlayerSpawned`) and
`noteRoundBoundary` (`EV.RoundStarted`), and read by `ServerMatch.streakEconomy` — which feeds
`main.ts`'s per-match JSON and the skirmish harness's blocking assertion. P5's grenade probe is a
different object entirely: `LifeStockAudit`, reporting `partialStock` through
`ServerMatch.equipmentAudit`. They share no code; they only both count life-starts off the same
spawn event, which is what makes them read alike.

What the counter tests is `kills + credits − spent !== 0` — **"this life started holding a
wallet"**. It is the wallet's life boundary measured at the spawn instead of at the death, with
the round-boundary count as its other end so it can fail in both directions. Only the
`|| used.length > 0` clause it also carried had anything to do with once-per-life, and that
clause is what this session removed. So the invariant is untouched by the pivot, and both halves
are renamed to say what they count: **`walletsAtLifeStart === walletsAtRoundBoundary`**.

Cooldowns are deliberately outside it. They are meant to cross a death, so putting them in a
counter asserted at zero would be building a counter to fail. `cooldownsCrossingDeath` is where
that decision is measured, and it is written to be read the other way round: in a run where
streaks were spent, a **zero** there means either nobody died inside a cooldown or the life reset
is clearing them — and the second is a bug that would look exactly like the first.

### The wire carries a duration where it carried a bit (protocol v13)

`StreakOfferState.used: boolean` became `lockoutCs: number`, u8 → u16, one extra byte per offer
and three offers per frame. A bit cannot express either new rule: the client has to know *how
long*, because the strip draws the wait as a fill, and it has to be the server's number, because
the clock is the simulation's tick and a networked client is not running it.

Everything else about the model is server-side by construction rather than by care, because all
three rules are inside `StreakLedger.charge` — the one door — and `activate` is the only way into
the world. The client's copies are advisory: `ReplicatedStreaks.canAfford` decides whether to
*send* a request, and `Server.onStreakRequest` decides whether to grant it.

### The HUD has a fill and no digits

The fourth slot state was `USED`, struck through. It is now a `<u class="hud-streaks__cool">`
absolutely positioned across the slot, drawn with `transform: scaleY(remaining / 30)` and clamped
at 1 — so a streak still in the sky and one whose cooldown has just started read the same, full,
and both drain over the last thirty seconds. No text and no number, which is what was asked for.

Clamping is what stops the same wait looking different on two keys: a fraction of the *whole*
lockout would be a bar falling at half speed on a sentry and at double on a mortar, for a reason
the player has no way to see.

Two things worth writing down because they are the mistakes this widget invites. The transform is
written every frame and is deliberately **not** in the slot's string cache — a transform
composites, a `textContent` reflows, and caching the one that is cheap costs a comparison to save
nothing. And the fill needed `isolation: isolate` on the slot: an absolutely positioned child
paints above its in-flow siblings whatever the DOM order, so without a stacking context the slot
owns, the bar covers the key, the name and the price. `opacity` on three of the four slot states
happens to create one — which is exactly the kind of accident that stops being true the first
time somebody sets a state to `opacity: 1`.

`npm run check:cosmetics` passes and was never at risk: it pins `EntitySnapshot`'s field set, and
this is `MsgS.Streaks`. Worth saying explicitly that the audit's line was honoured rather than
merely not tripped — **remaining time is still a number**, in `LedgerRow.cooldowns`, in
`StreakOfferState.lockoutCs` and in `StreakSlotState.lockoutSeconds`. The HUD is the one place it
stops being one.

### The earning side, confirmed rather than assumed

"Earn the points again in that same life" needs the kill counter to keep accumulating after a
purchase, and it does — structurally, not by a rule that could be forgotten. `foldKills` banks
the delta of `PlayerScore.kills` into `row.kills` and has no reference to spending; `charge` adds
to `row.spent` and touches nothing else; the balance is the difference. Nothing in `checkEarned`
was ever gated on the used set except the *announcement*, and that gate now lifts on the purchase
that consumed it, so a streak becoming affordable a second time in one life announces a second
time.

### Bots go through the same door, and there is still no bot behind it

The three rules live in `charge`, which `activate` calls before it builds anything, so every
caller inherits all three: `ClientMatch.spendStreak`, `Server.onStreakRequest`, `ConsoleApi` and
`StreakPanel`. There is no fifth. P4's finding is re-confirmed and still true — **nothing in
`shared/ai/` touches `StreakSystem` at all**, so no bot has ever spent a streak, and there is no
second economy because there is no second caller. When bot streak AI is built it inherits the
debit, the cooldown and the concurrency rule without a line of its own; that is the property this
session had to preserve and did, and it is not the same thing as bots participating today.

### Measured

Every number came out of a run in this session, named with the probe that produced it. The red
control is HEAD before this session (once-per-life, `used` bit), rebuilt and re-run on the same
inputs.

**`npm run harness` — 5 matches, seeds 1-5, TDM on Foundry, bots only.**

| | Red (once-per-life) | Green (cooldown) |
|---|---|---|
| Scores | 75-59, 75-66, 62-75, 75-66, 60-75 | **identical** |
| Life-starts / with a wallet at start | 722 / **0** | 722 / **0** |
| Round-boundary carry-overs | 0 | 0 |
| Kills banked, against 683 scored | 683 | 683 |
| Negative balances / anchor resyncs | 0 / 0 | 0 / 0 |
| Post-mortem kills dropped | 5 | 5 |
| Cooldowns crossing a death | — (no field) | **0** |
| Entitlement per life — threshold | 93 | 93 |
| Entitlement per life — once-per-life | 43 | 43 |
| Entitlement per life — **with repeats** | — | **46** |

**The scores are byte-identical, which is the regression control and is expected**: nothing in a
bot-only TDM match spends a streak, so nothing this change touched runs there. The three
entitlement ceilings all come out of that one run, on those five seeds, priced the same way — so
the pacing comparison is not two fights. Removing the once-per-life cap raises the ceiling from
**43 to 46** across 715 lives, a deliberately small move: a bot life almost never re-earns a
streak's price *and* outlives the 30 s-plus cooldown, so the two mechanics that replaced the cap
bind far less often than the cap did. `cooldownsCrossingDeath` is 0 here because no bot spends,
so no cooldown is ever armed — which is the same fact as `activations` being 0, from the other
side.

**`npm run skirmish -- --grant-streak uav` — 3 headless clients, real server, real wire, TDM.**
The only place in the project anything spends, and where the pivot is actually exercised: the
top-up funds the wallet every 15 s so the only thing stopping a re-buy is the cooldown and a UAV
still being up.

| | Red (once-per-life) | Green (cooldown) |
|---|---|---|
| Life-starts / with a wallet at start | 113 / 0 | 103 / 0 |
| Activations over ~21 top-ups | 23 | 17 |
| **Most of one streak bought in one life** | **1** | **3** |
| Most streaks (any kind) in one life | 1 | 3 |
| Refused unaffordable / cooling / already up | 0 / — / — | 0 / **0** / **0** |
| Cooldowns crossing a death | — | 19 |
| Negative balances / resyncs | 0 / 0 | 0 / 0 |
| Flow check | PASSED | PASSED |

**The row that is the whole session is `most of one streak in one life`: 1 → 3.** Under B10 a
life could not buy the same UAV twice however long it lived; here one life bought it three times,
by re-earning the four kills and waiting out the cooldown twice. The refusals are 0/0 because the
headless client does what a player does — it skips a key it can see is locked out rather than
spamming it — so the cooldown shows up as *fewer activations spread over more re-buys* rather than
as a wall of refused requests. The two runs are not the same seed (skirmish is wall-clock timed),
so the raw activation counts (23 vs 17) are not a same-seed before/after; the deterministic
harness above is where the ceilings are same-seed, and the skirmish is where the repeat is real.

`19 cooldowns crossed a death` is the decision measured from the front: streaks were bought,
players died inside the 30 s window, and their cooldowns kept running — which is exactly what
"dying does not shorten a wait" produces, and the opposite would have read as a 0 here that looked
just like a clean run.

**`npm run skirmish -- --vote 4` — the same three clients, Search & Destroy.** The wallet
carry-over invariant at a non-zero value: **6 life-starts inherited a balance against 6
round-boundary carry-overs**, 0 cooldowns crossing a death, flow check passed. Six wallets crossed
a round boundary and six were counted crossing it, from two different signals — the spawn and the
round turn — agreeing.

**`npm run server -- --mode SND --matches 5 --asap`, bots only.** `walletsAtLifeStart` against
`walletsAtRoundBoundary`, per match: **5/5, 3/3, 1/1, 3/3, 4/4** — equal in all five over 190
life-starts, 0 partial grenade stock, 0 negative balances. Identical to the numbers P5 measured
under the old field names, which is the point: renaming `dirtyLifeStarts`/`roundCarryOvers` and
dropping the `used` clause did not move the invariant, because the invariant was only ever about
the wallet.

**`npm run leak` — 100 cycles.** Subscriptions **29 → 29 (+0)**, heap 13.08 → 13.76 MiB. The
count matches P5's 29 exactly: this session adds no bus subscription, because the cooldown is a
map on a ledger row rather than a new listener.

**`npm run check` and `npm run build`** green, including `check:cosmetics` — the snapshot audit is
unaffected because the change is on `MsgS.Streaks`, not `EntitySnapshot`.

### What was not verified

The entitlement ceilings are exactly that — ceilings. `balanceRepeatPurchases` counts what a
life's kills *could* buy at the cheapest price with repeats allowed and infinite time; it does
not model the cooldown, on purpose, because the cooldown is a fact about how long a life lasted
rather than about the kills. The number an actual match produces is `activations`, and it sits
below the ceiling by whatever the cooldown took out. Both are reported so the gap is visible; the
gap itself is not separately measured.

`balance = earned − spent` is still not measured and still not measurable: the balance is computed
from the other two, so there is no third number that could disagree. What is measured is the pair
that can go wrong — a balance below zero, and a life that started holding one — both 0.

### Needs a browser

Nothing below is testable headlessly. `HeadlessClient` drives `NetClient` and `Prediction` and
builds no `ClientMatch`, so it has no streak strip and no keys; the preview pane never fires
`requestAnimationFrame`, so it cannot stand in for one. Every item is a networked match unless
said otherwise.

- **The repeat, which is the whole change.** Get a UAV up, let it expire, and keep killing. About
  thirty seconds after it comes down — its 30 s duration is already spent, so this is the cooldown
  — the slot must light again at four kills and the key must work a second time, **in the same
  life, without dying**. Under the old rule it stayed `USED` until death; there is no `USED` any
  more.
- **The fill, and that it has no digits.** While a streak is on cooldown its slot must show a bar
  draining from full to empty over thirty seconds, and **no number, no seconds, nothing counting
  down** — that is the acceptance criterion the brief set. A streak still live in the world shows
  the same full bar (it is clamped), so calling one in and immediately pressing its key again must
  do nothing and look identical to a fresh cooldown.
- **Concurrency without text.** Call in a sentry, then press its key again while it is still
  standing. The key does nothing and the slot shows the locked state — the same one a cooldown
  shows — with no message explaining why.
- **Other keys are unaffected.** With one streak cooling down, a *different* equipped streak you
  can afford must still fire. The lockout is per streak.
- **The chopper shortcut, if you want to see it.** Call in the chopper, get shot out of it early,
  then re-earn twelve kills in the same life: the chopper must be buyable again sooner than if you
  had flown it to the end, because its cooldown started when it came down. This is the one case
  where dying earlier helps, and it needs twelve fresh kills to reach, so it is hard to stage.
- **Create-a-Class is unchanged.** The killstreak rows still read `Costs N kills · …`; the pivot
  did not touch the editor.
- **Single-player.** All of the above works locally too — the local `StreakSystem` runs the same
  ledger. The one difference is that locally the fill comes off the client's own sim tick rather
  than off the wire.

### Found while here

- **No bot has ever spent a killstreak — re-confirmed, and now load-bearing.** P4 found there is
  no bot call site into `StreakSystem.activate`; that is still true (`grep` over `shared/ai/`
  finds no reference to the system at all). It matters more now, because the three new rules live
  behind the one door every activation goes through, so the day bot streak AI is built it
  inherits the debit, the cooldown and the concurrency check for free — there is no second path to
  keep in step. Not this session's item; the property was preserved rather than added.
- **`EV.StreakProgress` and `EV.StreakEarned` still have no gameplay subscriber.** Only the debug
  log listens. Both now carry balance-model numbers and the earned event now fires again when a
  streak becomes re-affordable in one life, but a streak coming off cooldown is announced to
  nobody — no cue that the key is live again. That is a gap an announcer would fill and is worth
  knowing before F16 adds three more streaks with cooldowns of their own to not announce. Left.

## Playtest round 5 — a layer that centred what it could not scroll to

Three reports, and the brief's own hypothesis was that they were one missing CSS property. That
is right about two of them and wrong about the third, and the third is the interesting one.

- **B1** — the main menu is cut off top *and* bottom and the wheel does nothing. Reported at
  1366x626 with the title at `y = -118` and `RESET PROGRESS` at `y = 700`.
- **B2** — under 840px wide the setup screen grows to 833px and `START MATCH` goes under the
  fold, so a solo match cannot be started in a narrow window at all.
- **B3** — the post-match board runs off the side and a horizontal scrollbar appears.

### The mechanism, and why the top half was the unreachable half

`.op-screen` is `position: absolute; inset: 0` — exactly viewport-sized, always — and it was a
flex column with `justify-content: center` and no `overflow`. When a flex line is longer than
its container the overflow is distributed to **both** ends. The half that goes off the bottom
is ordinary overflow. The half that goes off the top is at a negative offset, and there is no
scroll position that reaches a negative offset: `scrollTop` starts at zero and counts up. So
the menu was not a long page with a broken wheel. It was a page half of which had been placed
somewhere the wheel could not have gone even if there had been a scroll container to spin, and
the report's *"the wheel does nothing"* is the exact symptom of that rather than of a missing
`overflow-y`.

That is B1 and B2 both. B2 is a width bug wearing a height bug's clothes: `.op-pickers` is
`repeat(auto-fit, minmax(220px, 1fr))`, so below its cap the three columns fold to one and the
column stack grows past the window — the layer then does to it what it did to the menu. Fixing
the setup screen specifically would have fixed one screen and left the mechanism.

**B3 is not that property.** The brief's starting point was that the post-match board had never
had round 4's F11 convention applied — the content carries the cap, the layer stays full-bleed.
It has: `.sb--embedded` is `width: min(1040px, …)` and always was. The cap was **inert**.
`.sb__grid` was `grid-template-columns: 1fr 1fr`, and `1fr` is `minmax(auto, 1fr)` — a track
whose floor is its content's min-content size. Each team block's min-content is the row template
`Scoreboard.setColumns` writes: a 96px name column plus one fixed `ch` track per scoreboard
column, none of which can shrink. Two of those and a gap came to about 990px whatever the cap
said, so below roughly a thousand pixels the AXIS block simply left the box. **A cap cannot
shrink a grid that has a floor**, and that is the finding: the convention was applied and could
not work.

The horizontal scrollbar in the report was `.eom`'s. It set `overflow-y: auto` and nothing else,
and CSS computes the *other* axis to `auto` alongside a non-`visible` one — so asking for
vertical scrolling had quietly asked for horizontal scrolling too, and that is what caught the
990px.

### One rule at the layer

`.op-screen` now carries all of it: `justify-content: safe center`, `overflow: auto`,
`overscroll-behavior: contain`, and `padding: var(--s-8) var(--s-4)`. `safe` is the whole of
B1 — it centres while the content fits and falls back to `start` the moment it does not, so a
tall screen scrolls from its own top and no individual screen has to know how tall it is. Both
overflow axes are named rather than one, because naming one names the other anyway and that
should be deliberate; and `auto` rather than `overflow-x: hidden`, because clipping sideways
overflow would hide the layout that produced it instead of the layout being caught.

`.eom` and `.lo` had been writing that rule out for themselves — `overflow-y: auto`,
`justify-content: flex-start` and a padding each — and the main menu, the screen that got
reported, never had. Both are down to their `gap` now. The Settings screen was the one that did
not have this bug, which the brief noticed and which was not a coincidence: `.op-settings` has
carried `max-height: 56vh; overflow-y: auto; overscroll-behavior: contain` since M8 with a
comment describing the invariant. **Its own scroller is deliberately kept.** `Settings` carries
`scrollTop` across its rebuilds (round 3's fix for the list jumping to the top on a rebind), and
that offset is read off `.op-settings`; hoisting its scroll to the layer would have set it to
zero forever and reintroduced a bug this file already records.

### `vw` counts two things the content box does not

Every capped element was `width: min(<px>, N vw)`. `vw` is the viewport, including the scrollbar
and ignoring whatever padding the layer has — so the moment `.op-screen` gained a scrollbar and
16px of side padding, `96vw` was wider than the box it was measured into and the create-a-class
screen overflowed sideways at **every** viewport, by 3px at 1024 and 16px at 375. They are
`min(<px>, 100%)` now, which resolves against the layer's content box — the one thing that has
already subtracted both. The same edit at `.op-pickers`, `.sb--embedded`, `.eom__xp`, `.lo-head`,
`.lo-columns` and the settings pair. `.sb` (the floating Tab board) keeps `94vw`: it is
absolutely positioned against `#ui-root`, which has neither a scrollbar nor padding, so there
`vw` is honest and it is the only remaining one.

### The board folds, and its columns were sized against the wrong font

Two changes, and the second is the one that was hiding.

`.sb__grid` is `display: flex; flex-wrap: wrap` with `.sb__team { flex: 1 1 0 }`. A flex item's
hypothetical main size is floored by its automatic minimum — its min-content — so two blocks
that cannot both fit on a line become two lines, and the fold is where the content puts it
rather than at a breakpoint somebody chose. Same shape as `.op-pickers`' `auto-fit`, which is
already the file's answer to this question.

Then: `Scoreboard.setColumns` writes one `ch` track per column, and `ch` resolves against the
font of the element carrying the template. Every span inside a row sets its own size —
`.sb__col` at 10px, `.sb__name` and `.sb__cell` at 11px — and the row set none, so it inherited
the document's 16px and **every numeric column came out about 45% wider than the text it was
sized to hold**. `.sb__head, .sb__row` now set `font-size: var(--t-small)`. Nothing on the board
renders at that size, so it moves the track widths and nothing else; the visible effect is that
two team blocks still fit side by side at 800x600, where before the pair wanted 1006px.

Last, `minmax(96px, 1fr)` became `minmax(0, 1fr)` for the name column, and the argument is that
the floor only ever fired where it did harm. A `1fr` track already takes every pixel the fixed
columns do not want, so wherever the board has room the free space decides the name column's
width and 96px is never consulted. The only case it applied to was the case with no free space —
375px of window, 328px of box, 272px of fixed columns and gaps — where all it could do was turn
the 56px that were left into a 96px overflow. `.sb__name` has carried
`overflow: hidden; text-overflow: ellipsis` since M4 for exactly this.

Two more of the same shape, found by the probe rather than reported, and fixed because they are
the same cause (P0 rule 8): `.eom__personal` was `grid-auto-flow: column`, which cannot wrap —
six stats answered "how wide" with "as wide as six stats", 451px of them in a 375px window — and
is now the same wrapping flex row; and `.op-setting`'s `1fr 220px 64px` is
`1fr minmax(0, 220px) 64px`, so the control column gives ground before the value readout goes
off the side. Neither moves at any width where they already fitted.

### The probe, because P0 rule 7 says a layout bug here is a number

`npm run layout`. `probes/layout.html` mounts the front end's screens with no canvas and no
renderer, `scripts/layout-probe.mjs` drives a headless Chrome over the DevTools Protocol, and
each of six viewports is measured with `getBoundingClientRect` — which is how all three of this
round's reports were found in the first place. Ten surfaces: the menu, the setup page, all four
settings tabs, pause, the summary, and the loadout editor open and with a row expanded.

It asserts two things.

- **Reachable.** Every laid-out element must be wholly inside the viewport after
  `scrollIntoView({ block: 'nearest', inline: 'nearest' })` — the minimum scroll that would
  reveal it if any scroll could. That phrasing is the point: an element off the bottom of a
  scrollable screen passes, an element off the top of the same screen fails, and that asymmetry
  is B1 exactly. An element bigger than the viewport on an axis is skipped on that axis and its
  children are not, so a 900px column in a 626px window is the subject of the test rather than a
  violation of it.
- **No sideways scrolling.** Any element whose used `overflow-x` is `auto` or `scroll` must have
  `scrollWidth <= clientWidth`. Vertical overflow is a legitimate answer to a long screen;
  horizontal overflow is not.

The viewport list is `src/client/probes/Viewports.ts`, in the repository rather than in the
report, each entry with the reason it is there. `?show=<surface>` on the page leaves one screen
up instead of measuring it, which is how the browser half of this session was done and how the
next one can be: open `/probes/layout.html?show=summary` and drag the window.

**Why it is not in `npm run check`.** `npm run build` runs `check`, and the deploy host has no
browser on it. So this sits beside `readability` and `progression` as an instrument, and the
browser it needs is named in the failure message rather than assumed. Chrome or Edge is found
from `CHROME_PATH` first and then the usual install locations; `ws` is already the one permitted
server dependency, so the protocol client is forty lines and S2's no-new-libraries rule is
intact — no Puppeteer.

The columns the summary board is measured with are **derived**: every mode is built the way
`auditModeBriefs` builds them and the one with the most `ch` wins, so a sixth mode with an eighth
column is covered on the day it is added rather than on the day somebody reports it.

### Measured

Every number below came out of `npm run layout` in this session, on Chrome from 1366x626 down to
375x812 with `deviceScaleFactor: 1` and Windows' classic scrollbars — which is the conservative
reading, since an overlay-scrollbar platform gives each layer 15px more.

Red control first, on the tree as it was, with the probe in and nothing else changed:

| Run | Violations | What had changed |
|---|---|---|
| Red control | **86** | nothing |
| After the layer rule and the `100%` caps | **12** | `.op-screen`; six `vw` caps; `.eom` / `.lo` de-duplicated |
| After the board's fold and its `ch` font | **10** | `.sb__grid`, `.sb__head` / `.sb__row` |
| After `.eom__personal` and `.op-setting` | **1** | two more grids that could not fold |
| After the name column's floor | **0** | `minmax(96px, 1fr)` to `minmax(0, 1fr)` |

The reported screens, by the numbers:

| Report | Viewport | Before | After |
|---|---|---|---|
| B1 — title | 1366x626 | `OPERATOR` top at **y = -127**, 127px above the window, unreachable | top at **y = +32** at rest, which is the layer's own padding |
| B1 — `RESET PROGRESS` | 1366x626 | y **710..753**, 127px below a 626px window, unreachable | bottom at **626** after `scrollIntoView`; 317px of scroll range |
| B2 — `START MATCH` | 596x696 | y **787..834**, 138px under the fold; 13 violations on that screen | reachable; **0** violations |
| B3 — the summary layer | 800x600 | `.eom` scrolls sideways: **1006px** of content in an 800px box | no sideways scroll; board content **768px**, still two columns |
| B3 — the summary layer | 596x696 | **998px** in a 596px box | folded to one column, **549px** |
| B3 — the summary layer | 375x812 | **989px** in a 375px box | **328px** |

The report's own figures were `y = -118` and `y = 700` for B1 and `y = 785` for B2; the probe's
are `-127`, `710` and `787`. The difference is the probe's status and profile lines being a
different length from the deployed build's, not a different bug. The report's *"content height
is 744px"* is `scrollHeight`, which cannot see the half of the overflow above the origin — the
laid-out content at that viewport is 879px tall, which is why 744 and -118 never added up.

`npm run check` green. `npm run build` green, and `dist/` contains no probe page — the second
HTML file is served by the dev server and is not an entry of the client build. No harness was
run: nothing here touches simulation, the wire or a protocol version. Outside `client/ui/` the
only changes are the new instrument (`probes/`, `src/client/probes/`, `scripts/layout-probe.mjs`,
the `layout` script) and `Scoreboard.ts`'s one template string, which is `client/ui/`.

### Verified by eye, in a real browser

The probe says every box is inside the window. It does not say the screen still reads right at
that size, so `?show=` was used at 1366x626 and 596x696 on the dev server: the menu now starts
at its title with a live scrollbar and the wheel reaches `RESET PROGRESS`; the setup page scrolls
to `START MATCH`; the summary board is two columns at 1366 and one at 596 with the AXIS block
whole in both. The wheel works because `Input.bindingsActive` is already false outside `MATCH`,
so nothing calls `preventDefault` on a scroll while a front-end screen is up — that is round 3's
fix still holding, one layer up from where it was written.

One deliberate visual change: the summary and the loadout editor used to be pinned to the top
of the screen by their own `justify-content: flex-start`, and now they centre when they fit and
start when they do not, like every other screen. That is what one rule at the layer costs, and
it is the better of the two behaviours.

### Needs a browser

- ~~**A real 1366x768 laptop, maximised and then at half width.**~~ **Done.** Scrolling
  confirmed at full width and at half width; `RESET PROGRESS` reachable and a solo match starts
  in both.
- ~~**A phone, held upright.**~~ **Done.** The name column's truncation at 375px was looked at
  and accepted. F1 still owns whether a phone should be offered a game at all.
- **A browser without `justify-content: safe`.** Safari below 17.6 drops the whole declaration,
  which leaves `flex-start` — every screen top-aligned, nothing unreachable, and slightly less
  pretty. Believed rather than measured: no such browser was run.
- **Scroll feel on a trackpad.** `overscroll-behavior: contain` was added to the layer for the
  reason it is on `.op-settings`, and the settings screen is now a scroller inside a scroller.
  It cannot be measured whether reaching the end of the binding list and carrying on feels like
  one gesture or two.

### Found while here

- **`.sb`'s 94vw is now the only `vw` cap outside the loading screen, and it is on the one
  element that is not inside `.op-screen`.** Correct today for the reason above. If the in-match
  board is ever moved into a layer with padding, it inherits the bug this session removed
  everywhere else. Left, with the reason written next to it.
- **The scoreboard's `ch` widths were 45% oversized for eight milestones and nobody could have
  seen it**, because the columns still lined up — everything was wrong by the same factor. It
  only became visible as an overflow. Worth remembering as a shape: a unit resolved against the
  wrong font is invisible until something has to fit.
- **`.op-setting--stack` exists and is now nearly unnecessary.** With the control track able to
  shrink, the reason a setting had to declare itself full-width is mostly gone. Not touched: the
  settings using it are using it for a reason of their own (a control that wants the whole row),
  and unpicking that is not this session's item.

## Playtest round 5 — one cursor dealt the spread, and the spread landed on one side

**B4** — *"the only VETERAN in the mix always falls on the opposing team"*, with two matches whose
rosters were byte-identical and that bot finishing 36 kills to 5. The report was right that it is
"always", and right that it is not a seed.

### The mechanism

`BotDirector.populate` advanced **one cursor** through `tierMix` and filled team A to completion
before team B started. That makes "which side does this tier land on" a pure function of the
tier's *index in the literal* against `teamA`: everything below the index is team A's forever,
everything at or above it is team B's forever. Foundry and Dunes put `VETERAN` at index 4 and a
solo 5v5 deals four bots to A, so index 4 was the opposition's first bot in every match ever
played. Re-deriving the report's two rosters from the literal reproduces them entry for entry.

The same literal punishes a different side at each of the three splits the project actually
deals, which is why this is one mechanism and not one bug:

| call site | split | the VETERAN always lands on |
|---|---|---|
| `ClientMatch.populateDefault` — solo 5v5 | 4 / 5 | **B**, the report |
| `ServerMatch.populate` via `LiveMatch` (`bots: 10`) | 5 / 5 | **A**, and B never gets one |
| the same, FFA (`rosterSize: 8`) | 4 / 4 | **B** |

### The brief's assertion was already true, so it could not have been the probe

The brief asked for *"the multiset of tiers on team A and on team B differ by at most one entry"*.
Checked against the shipped literal at all six shipped configurations, **that is green on the
broken build** — the reported roster, `A = REGULAR HARDENED RECRUIT REGULAR` against
`B = VETERAN HARDENED REGULAR RECRUIT REGULAR`, satisfies per-tier parity exactly. An assertion
of that shape would have been a regression guard for a future edit of the mix and would not have
caught the thing that was reported. It is asserted anyway, because a property that is implied is
still a property somebody will change; it is just not the probe.

What is red on the broken build is stated differently, and in two parts:

- **Containment.** The side with fewer bots must hold a *sub-multiset* of the side with more.
  Today the two sides hold tiers the other does not: on Depot, on the live 5v5 and on FFA.
- **The short side keeps the stronger half.** The bodies it does without must be the weakest
  ones dealt. On the report's own roster the body team A did without was the VETERAN.

### The deal, and the decision the brief asked to be made out loud

`shared/ai/RosterDeal.ts` is new and it is one function: the long side takes the first
`max(a, b)` entries of the cyclic mix, and the short side takes the same entries minus the
`|a - b|` **weakest** of them. Two consequences, both provable rather than observed:

- when the sides are even the two rosters are **identical**, which is every live-server match;
- when they are not, the short side is contained in the long one and the two differ by exactly
  `|a - b|` entries — the fewest the head-count allows.

The brief asked for an explicit choice between *"mirror the spread and accept the human seat as
the handicap"* and *"deal the stronger half to the player's side"*. **The second**, phrased so
that it needs no knowledge of where the humans are: a side is short a bot precisely because
something else holds that seat, so **the side that is a body down keeps the better bodies**. In
solo the short side is always the player's, because the player fills the missing seat. On a
dedicated server it is simply short, and the same compensation is right for the same reason.

That phrasing is load-bearing rather than stylistic. At `ServerMatch.populate` there are **no
humans at all** — the match is built and then humans take seats through `removeBotForSeat` — so
a rule written in terms of "the player's side" could only have been an `if (networked)` branch,
which is the shape P0 rule 1 bans by name. Written in terms of bodies it is one rule in both
runtimes.

Strength order is `BOT_TIERS` itself, which has been authored weakest-first since M3 and is
already the order the difficulty picker offers. Nothing here invents a ranking.

**The rejected alternative was to vary the deal by seed**, and it is worth recording why,
because it is the obvious answer and it is a non-fix: `MatchWorld.AI_SEED` is a **constant**,
deliberately, so every solo match would have drawn the same offset and the report's two
identical rosters would have survived the fix untouched. The defect had to be removed from the
arithmetic, not sampled around.

### `replacePlayerWithBot` is the same rule asked from the other end

Round 4's F1 already found this call site dealing tiers by a rule of its own, and it was doing
it again: `mix[this.bots.bots.length % mix.length]` — a third cursor, next to the two `populate`
used, indexing by the *total* bot count and knowing nothing about either side's composition. So
a replacement could deepen exactly the imbalance the deal exists to prevent.

It does not restate the rule now, it asks it: deal the roster this side would have had at one
body more, and hand back whatever this side is short of. One description of a balanced roster,
and every caller derives from it. `BotDirector.tiersOn(team)` is the roster's own answer to
"what is this side", which is what the two call sites now compare.

That pairing is asserted rather than assumed, and getting it asserted is what caught the first
version being wrong: a fallback that returned "the weakest tier in the mix" whenever no tier was
short looked reasonable and failed 3 configurations in 10, because a side that is already the
long one is owed its *next* seat, not the cheapest one. The audit walks the whole cycle a human
puts a side through — `removeOne` takes the newest bot off, `tierForExtraBot` names the tier
that comes back — and the roster has to end where it was dealt.

### Measured

Every number below came out of a run in this session. The deal is a pure function of
`(teamA, teamB, mix)`, so the sweep is the **whole domain** rather than the hundred seeds the
brief asked for: every authored spread against every split up to a full roster, 676 deals, which
makes one green run a fact rather than an estimate. There is no seed left to sweep, and saying
so is the more honest artefact.

**`npm run harness` — the audit, red control first.** The red control is the shipped one-cursor
deal, restored behind the new audit on the same tree with nothing else changed:

| Run | Deals | Problems |
|---|---|---|
| Red control — the one-cursor deal | 676 | **3303** |
| After | 676 | **0** |

The red control names the report's own case in the words of the property it breaks:

    mp_foundry 4v5: the smaller side does without a VETERAN while keeping a REGULAR.
                    The side that is a body down keeps the stronger half, not the weaker one.
    mp_foundry 5v5: the smaller side holds 1 VETERAN against the larger side's 0.
    mp_foundry 5v5: the rosters differ by 2 entries where the head-count only forces 0.

**The rosters, before and after, at the four shipped shapes on Foundry:**

| Split | Before | After |
|---|---|---|
| 5v5 (live match) | A `R H Rc R V` / B `H R Rc R H` | A `R H Rc R V` / B `R H Rc R V` — identical |
| 4v5 (solo, a human in A) | A `R H Rc R` / B `V H R Rc R` | A `R H R V` / B `R H Rc R V` |
| 4v4 (live FFA) | A `R H Rc R` / B `V H R Rc` | A `R H Rc R` / B `R H Rc R` — identical |
| 3v4 (solo FFA) | A `R H Rc` / B `R V H R` | A `R H R` / B `R H Rc R` |

The 4v5 row is the report. The VETERAN is on **both** sides now, and the one body the player's
side does without is the RECRUIT — the weakest in the spread rather than the strongest.

**`npm run harness` — five matches, unpaced, per tier per side.** The team column is new
(`BotReport.perTeamTier`): the old table had no way to express B4 at all, because a tier dealt
only to one side looks entirely ordinary in a row with no side in it. Totals across the five
matches, which run at `--bots 10` and therefore at the 5v5 split:

| Tier | Before — A | Before — B | After — A | After — B |
|---|---|---|---|---|
| RECRUIT | 5 slots, 18k/73d | 5 slots, 16k/65d | 5 slots, 25k/71d | 5 slots, 35k/64d |
| REGULAR | 10 slots, 119k/136d | 10 slots, 125k/140d | 10 slots, 109k/134d | 10 slots, 102k/144d |
| HARDENED | 5 slots, 104k/63d | **10 slots**, 200k/142d | 5 slots, 103k/66d | 5 slots, 93k/64d |
| VETERAN | 5 slots, 107k/70d | **none, in all five matches** | 5 slots, 94k/74d | 5 slots, 115k/59d |

The point is not that the numbers are equal — they are not, and a symmetric roster does not make
them so. It is the slot counts: `VETERAN … B —` printed in all five matches before, and every
tier on both sides in all five after. The VETERAN's kills were 107 on one side and none on the
other because there was no other; they are 94 and 115 now, and which side is ahead moves match
to match.

**The rest of the gate.** `npm run check` green. `npm run skirmish` — the full connect, warmup,
vote, migrate, match, return flow — `FLOW CHECK PASSED`, 3 migrations, 0 failed.
`npm run leak` — 100 allocate/destroy cycles, subscriptions 29 → 29 (+0), heap 13.11 → 13.80 MiB
(+0.69), `LEAK CHECK PASSED`. `npm run netharness` against a real `serve.js` — 2 headless clients,
30 s, 0 snapshots lost, worst misprediction p99 0.781. **No protocol change**: the deal is
composed before anybody is on the wire and nothing about a bot's tier is replicated, so there is
no version to bump.

### What was not verified

- **Whether the match is now more fun, or more winnable.** The roster is symmetric; that is a
  statement about the deal and not about difficulty. Round 4's F1 difficulty picker remains the
  control for how hard a solo match is, and this session deliberately did not touch it.
- **Whether the solo 5v5 is now correctly balanced.** It is not, and it cannot be made so by a
  deal: team B has five bots and team A has four bots and a human. The spread is mirrored and
  the short side keeps the better bodies; the remaining edge is the human seat itself, which is
  the thing this session decided to compensate rather than to erase.
- **The live-server path with humans on both sides.** `smallerTeam` and `removeBotForSeat` are
  exercised by the skirmish harness with three clients; a full ten-human lobby joining, leaving
  and being replaced was not run.

### Needs a browser

Nothing for correctness — the deal measures cleanly, which is what the brief predicted. Two
things a human would see and a harness cannot:

- ~~**Solo, twice.**~~ **Done.** Two solo matches played; the opposing side no longer reads as
  having one player who is not like the others.
- ~~**A live match with a friend.**~~ **Done.** The balance was reported as good.

### Found while here

- **`BotDirector.removeOne` takes the newest bot on a side, so a joining human displaces
  whichever tier the mix put last.** That was true before this session and is still true; what
  changed is only which tier that is. On Foundry it is the VETERAN, on Depot a HARDENED — it
  tracks the authored order rather than strength, so it is not a systematic filter. Worth
  knowing before somebody decides a joining human should displace the *weakest* bot, which is a
  defensible rule and a different session's.
- **`ServerMatch.populate` splits an odd roster as `teamB = ceil(total / 2)`, so team B gets the
  extra body on an empty server.** With no humans yet that is an arbitrary tie broken one way,
  and it is why the live FFA split is 4/4 and the TDM one is 5/5. The deal now mirrors whatever
  split it is handed, so this no longer decides anything about tiers — but it still decides
  which side is a body up before the first human arrives. Left; it is head-count, not spread.
- **`ClientMatch` seeds every solo match from the constant `AI_SEED`.** Deliberate, documented,
  and load-bearing for the client-side bot harness — but it means *nothing* in a solo match
  varies between runs except the player. Any future report of the form "it is the same every
  time" should start there rather than at the system being blamed.

## Playtest round 5 — the checker was comparing the score against a value nothing writes

**B7** is the only item this round the game reported about itself: dozens of `error` lines from
the deployed build, *"DIVERGENCE on tick 67010: scoreA — client says 0, server says 69"*, both
scores, same tick, confirmed across four consecutive snapshots.

The brief offered two readings and asked which. **Both are wrong**, and the real one is worse
than either.

### The two the brief offered, and how each died

**A rotation seam, with the detector comparing across a boundary.** The console lines around the
divergence are a rotation, a rebuild and a rejoin, and the hypothesis was that the detector was
holding an outgoing match's score against an incoming world. It cannot: `MatchWorld.divergence`
is `readonly divergence = new DivergenceChecker()` on the **world**, and a rotation rebuilds the
world. There is no boundary for records to cross. The rotation lines are contemporaneous noise.

**The score does not replicate to a client that joins mid-match.** This one was worth the fear —
it would have been a real, visible, shipping bug invisible to every earlier round, because every
earlier round joined at the start. It is not true, and now there is a number instead of an
argument. `NetSession.update` re-emits `EV.ScoreChanged` from the header, edge-triggered against
`lastScoreA = -1`, so the *first* snapshot a joining client applies already differs from the
baseline and paints the server's score. Measured on three drop-and-return cycles: a client
dropped while the score was **8-11** came back rendering **9-13**, which is the score as it stood
after two kills it never saw. It did not miss the score; it did not even miss the update.

### What it actually was

`ModeStateHash`'s own comment promised the pair: the hash catches transport faults and *"the
score-versus-events comparison in `DivergenceChecker`"* catches the server being wrong about its
own game. `DivergenceChecker`'s comment described that comparison in detail — kills arrive as
`damage.dealt`, go through `ScoreSystem`, the mode derives a team score, and that number is
compared against the header.

**That comparison does not exist on a dedicated server**, and the file next door says so.
`MatchFlow` builds a replicated client with `authoritative: false`, and its kill handler is
explicit: *"The mode must not run here ... the server has already scored this kill and
replicated the total."* So `mode.teamScore` on a networked client is not a second opinion. For
Team Deathmatch, Domination, Kill Confirmed and Search & Destroy it is a **structural constant
zero** — all four read a team total that only `GameMode.addTeamScore` writes, and the mode never
runs. The checker compared zero against the server's score and fired, correctly by its own
rules, in every networked match of those four modes as soon as a score survived four snapshots.
The `75` in the report is Team Deathmatch's `scoreLimit`, exactly.

Free-for-All is the exception and it is why this survived a milestone looking plausible: its
`teamScore` is the highest kill count among its own rows, which the replicated path *does*
maintain. Measured, it reads **2** where the server says 69 — so even the one mode that tracked
was wrong for any client that had missed a kill, which is every client that ever joined late.

**The conclusion this forces, and it is the finding:** a client on a dedicated server cannot
audit the server's arithmetic. It holds strictly less than the server held when it computed the
number. The comparison was written against a client that simulates its own match — which is
single-player, where there is no header to compare against.

### Why a milestone of green harness runs never saw it

`DivergenceChecker` is in `shared/` with a comment arguing that two copies of a comparator are
two comparators that can disagree. It had **one** caller: `MatchWorld`, in the browser.
`HeadlessClient` never used it — it compares state hashes directly, with a streak counter of its
own. So the comparator the gate exercised and the comparator a player ran were different code,
and the browser's was the broken one. That is P0 rule 7's verification split turning up as a bug
rather than as a gap, and it is the sentence to carry forward: **a shared class with one caller
is not shared, it is misfiled.**

### The fix, in three parts

**1. The readers, because a migrated fact breaks all of them at once.** `mode.teamScore` had
three client call sites. The divergence checker was the loud one; the other two were silent and
had never been reported — `Game.pauseStatusLine` and `debug/ModePanel` both printed `0 – 0` for
the whole of every networked match, on the two surfaces whose job is to say what the state is.
All three read `MatchFlow.teamScore` now, which prefers the replicated value and falls back to
the mode in single-player.

**2. A gate, so the next migration is not found by a player.** `scripts/check-authority.mjs`,
in the family with `check-optics` and `check-unlocks`: one row per fact that has moved to the
server, naming the local accessor a client may not reach for. Both accessors are
`(team: ScoreTeam) => number`, so no type can tell them apart and a grep is the honest
enforcement — the same instrument `check-cheats` uses for the same reason. In `npm run check`.

**3. A check that can actually fail, because otherwise the fix is a false green.** With the
score comparison demoted to what it always was — header-fed, a guard against a second writer
rather than a second opinion — `DivergenceChecker` had nothing left that could find the server
wrong. So the browser now runs the state-hash comparison `HeadlessClient` has run since Gate B:
`NetSession` forwards `onStateHash`, and `MatchWorld` hashes its own mode state against the
instance's. The fact builder moved into `shared/debug/ModeStateHash` so there is **one**
description of what the hash covers instead of the instance's private copy and no client copy at
all — and that is only possible because of part 1: `MatchFlow.teamScore` is the one accessor
that is correct in both runtimes, so the identical call works on an authoritative instance and
on a client that scores nothing.

`ModeStateHash`'s comment claiming the score-versus-events comparison exists has been rewritten,
and so has `DivergenceChecker`'s. A comment that describes a check the code cannot perform is
the thing that let this run for a milestone.

### Two defects in the new wiring, both found by running it in a browser

Wiring the browser check found two faults in it within twenty minutes, which is the argument for
having wired it:

- **A client the server had dropped kept comparing.** Every other replicated fact is applied
  inside `update()`'s `state === 'joined'` guard, but a hash arrives on the socket. A dropped
  client stops applying snapshots, keeps decoding what is still buffered, and its `MatchFlow`
  freezes at the last phase it was told while the hashes describe a live match — a guaranteed,
  confirmed mismatch, at `error`, about a connection that is gone. Measured: **39 error lines in
  six seconds** from one starved client. That is B7's own shape, and shipping it inside B7's fix
  would have been a poor joke.
- **The comparison ran before the state it describes was applied.** The instance sends the hash
  **last** in its tick precisely so a client has applied every channel for tick N before being
  asked about tick N. This client does not apply the header on the socket callback; it applies it
  in `update()`, once, from the newest snapshot. So a burst of buffered frames fired the callback
  several times before `applyReplicated` ran once, and every one of those compared a `MatchFlow`
  still holding its constructed `WARMUP`. Measured: **three confirmed records on every join**,
  all the same pair, none after the first half-second. The hash is held and compared in
  `update()` after `onMatchState` now, which is where the ordering contract is actually
  satisfied.

### Measured

Every number came out of a run in this session. **No protocol change** — nothing new is on the
wire; `StateHash` has been sent since Gate B and the browser was simply not listening.

**`scripts/check-authority.mjs`**, red control on the tree as it stood:

| Run | Client files scanned | Readers of the local copy |
|---|---|---|
| Red control | 116 | **6**, across 3 lines — `MatchWorld` x2, `Game.pauseStatusLine` x2, `ModePanel` x2 |
| After | 116 | **0** |

The red control found its own bug first, and it is worth recording: the first stripper blanked
template literals wholesale, so `` `${mode.teamScore('A')}` `` was invisible and only two of the
three call sites were reported. Watching it go red is what showed that two were missing.

**`npm run harness` — the replicated-score audit**, a pure function of the shipped modes, so one
run is a fact. Twelve kills replayed onto a replicated `MatchFlow` per mode, then both accessors
asked what the score is against a server saying 69:

| Mode | `mode.teamScore` — the old operand | `flow.teamScore` — the new one |
|---|---|---|
| TDM | **0** | 69 |
| DOM | **0** | 69 |
| KC | **0** | 69 |
| FFA | **2** (derives from the rows) | 69 |
| SND | **0** | 69 |
| RANGE | **0** | 69 |

That table is B7 in six lines: four structural zeros, one mode that tracks and is still wrong by
67, and one accessor that carries the server's number every time.

The audit was itself wrong once, and the mode that caught it is the one that could: emitting the
kills before the replicated `LIVE` phase put every one of them into a `WARMUP` that dropped them,
and Free-for-All read zero for the audit's own reason rather than the code's. Ordering fixed;
the row that proves the exception is the row that proved the probe.

**`npm run skirmish -- --drop-return 3`** — the mid-match rejoin, which is the join-in-progress
path this game actually has:

    reconnect: 3 cycle(s), 3 kept the seat, 3 kept the score, 3 resynced,
               3 came back knowing the team score; divergence after return 0/12474

    team 8-11  at drop -> rendered 9-13  -> 9-13  on the instance
    team 11-23 at drop -> rendered 11-24 -> 11-24 on the instance
    team 11-24 at drop -> rendered 11-24 -> 11-24 on the instance

Asserted as a **bracket** rather than an equality, for standing lesson 3's reason: the client's
header is up to a snapshot old, so exact equality fails on a timing accident. What cannot happen
if the score replicates is for it to come back below what it was when the client left, or above
what the instance holds now. Both bounds are read off the instance, so neither is an invented
tolerance. Cycle one is the whole answer to H2: the score moved by three points while that client
was away and its first frame back carried the new number.

**A real browser, against a real `serve.js`, on the built client:**

| | Before | After |
|---|---|---|
| Header samples | — | **5178** |
| Hash samples | **0, ever** | **539** |
| Confirmed mismatches | — | **0** |
| `scoreA` / `scoreB` divergence lines | the report's dozens | **none, in the whole session** |

The zero in that table is the point: the browser had never taken a state-hash sample, because
nothing wired it.

**The rest of the gate.** `npm run check` green, including the new audit. `npm run harness` five
matches, all completed. `npm run skirmish` `FLOW CHECK PASSED`. `npm run leak` 100 cycles,
subscriptions 29 → 29 (+0), heap 13.13 → 13.82 MiB (+0.69). `npm run netharness` against a real
server, 2 clients, 30 s, 0 snapshots lost, worst misprediction p99 1.041.

### What was not verified

- **B7's log line was not reproduced in a browser.** The warmup arena is the only instance a
  pane can reach without a vote cycle, and it scores nothing (`records: false`), so both sides
  are zero there and the comparison cannot fire. The mechanism is proved by the audit's numbers
  and the observation is the report's own log; the two agree, but they are not the same evidence
  and it would be dishonest to present them as one.
- **A full match's worth of hash samples in a browser.** The pane does not fire
  `requestAnimationFrame` — measured, not assumed: the server tick sat at 0 and the server
  eventually closed the connection with `timeout`. The session was driven by pumping
  `NetSession.update()` from the console, which is the same code path minus the rendering, and
  which is what the numbers above come from. Whether a real browser stays at zero mismatches
  across a whole live match, through a vote and a migration, is a browser pass.
- **The score comparison can no longer find the server wrong**, and nothing can. That is not a
  regression, it is the truth becoming visible: it never could. The state hash is the check with
  teeth, and its limits are written in `ModeStateHash` rather than implied.

### Needs a browser

- **Join a live match from a second window and read the banner on the first frame.** The
  headless bracket says the score is there; what a person can check is that it is on screen and
  not `0 – 0`.
- **Pause, mid-match, on a server.** The status line under PAUSED should now read the real score.
  It read `0 – 0` for the whole of M10 and M11 and nobody reported it, which is worth knowing
  about how visible that surface is.
- **A whole live match with the console open.** Zero `[divergence]` lines is the claim; a vote,
  a migration into a live match, ten minutes, and back to the arena is the test. Anything that
  does appear now is a real transport fault and worth reporting verbatim.

### Found while here

- **`HeadlessClient` still has its own copy of the hash comparison**, with its own confirm
  streak and its own counters, next to the shared `DivergenceChecker` the browser now uses. It
  is kept because it carries a dimension the shared one does not — samples and mismatches counted
  separately *after a return*, which is what round 4's F8 probe reads. Two comparators of one
  thing is the smell this session's finding is about, and folding the after-return dimension into
  the shared checker is the way to close it. Not this session's item; recorded because the next
  person to read `DivergenceChecker`'s "two copies" argument should know there are still two.
- **`MatchFlow.publishScore` reads `mode.teamScore` and is only ever called from the simulated
  path**, so on a replicated client `EV.ScoreChanged` comes from `NetSession` re-emitting the
  header instead. Two emitters of one event, split by runtime, and the reason the HUD banner was
  fine while the pause line was not. It works; it is not obvious; it is the next place this class
  of bug will be found.
- **B8 reproduced itself while this was being verified.** `[Input] pointer lock request rejected:
  WrongDocumentError` in the pane, exactly as the round-5 report describes, followed by a match
  that runs on unaimable. P6 owns it.
- **F12's observation reproduced too**, and not in a hidden tab: `[netclient] 60 ticks behind the
  server clock; resynchronising` in a run of dozens, ending in `server closed the connection:
  timeout` — from a *visible* pane that was not being driven. The report flagged it as needing
  reproduction because it was seen in a hidden tab; the same lines come out of any client whose
  frame loop stops, which is a broader cause than P14's brief assumes.

## Playtest round 5 — a shot is not a damage event

**B5** was `CINDER · ACC 267%` on the post-match board, out of `25 shots / 62 hits`, with the
same number on Tab. The brief had already found the mechanism and named the file: `ScoreSystem`
counted `shotsFired` from `weapon.fired` — one trigger pull, one increment — and `shotsHit` from
`damage.dealt`, which is one **damage event**. Two populations, one division.

### One of the three shapes the brief listed is not real, and the measurement says so

The brief predicted three inflating shapes, and the session's first job was to kill any of them
that could be killed rather than fix all three:

- **Multi-pellet** is real and is the report. A `shotgun_breacher` pull sends eight rays and each
  one that finds a body is its own `damage.dealt`.
- **Penetration is not.** The brief said *"a penetrating round produces one per victim"*.
  `Ballistics.fire` returns the moment a body is hit — the `MAX_PENETRATIONS` loop is about world
  geometry, and a body ends the ray. Measured rather than argued: a carbine through a wooden
  partition at two posts standing in line put **30 damage events on 1 body from 30 rays**, and a
  control run with the near post removed connected **27 of 30 on the far post**, which is what
  makes the first number a fact about `Ballistics` and not about where the posts happened to be.
- **Explosive is real and wider than reported.** `EquipmentSystem` applies a blast under the
  thrower's own `sourceId`, once per body in radius, with no `weapon.fired` behind it at all. So
  do `MortarStrike`, `ChopperGunner` and `Melee` — a knife emits `melee.swing`, not
  `weapon.fired`. `SentryGun` is the exception and only by accident: it applies under the
  sentry's own entity id, which has no scoreboard row.

### The decision the brief asked to be made out loud

**A shot is one ray that left a barrel. A hit is one ray that found a body.** Explosives,
equipment, melee and killstreak weapons deal damage and are not counted: accuracy answers *"of
the rounds you sent, how many connected"*, and a grenade sends none.

It is enforced by shape rather than by discipline. `shared/combat/ShotAccounting` exports the
pair — `shotsFrom`, `hitsFrom` — and both take a `FiredShot`, which a `damage.dealt` payload
cannot satisfy. A future counter that subscribes to damage and reaches for them gets a compile
error instead of a percentage over one hundred. That is the whole point of the pair: the brief
said five call sites *"agree by luck"*, and a type is what makes them agree on purpose.

`meta/MatchProgression` had the right definition since M5 — `tally.shotsFired += p.pellets` — so
the game was showing two answers to one question on two screens: the per-weapon accuracy in
Create-a-Class was right while the scoreboard column next to it was not. There is one now.

### The sixth call site, and it was in the instruments

The brief named five. There is a sixth, and it is the harness's own: `netHarness` printed
`hitRate: hitsDealt / shotsFired` — damage events over trigger pulls, B5 exactly, one layer
down — and `HitTest` divided the same pair. They agreed by luck for the reason the brief means
literally: a headless client carries the default carbine, and a carbine fires one ray and throws
no grenades. `HeadlessClient` counts `shotsHit` beside `shotsFired` now, both off the same
replicated `weapon.fired`, and `hitsDealt` keeps the name it always deserved — damage events in
which this client was the shooter, which is not a hit count.

### The wire carried a bit where a statistic was needed (protocol v14)

There is no scoreboard on the wire. A client builds its own out of replicated events, so the
accuracy column for every remote player is computed from `FiredEvent` — and `FiredEvent` carried
`hitTarget`, one bit. `NetSession` therefore synthesised `pellets: 1, pelletsHit: hitTarget ? 1
: 0`, which means that after the counters were fixed a client would have counted **pulls** for
remote shooters while the server counted **rays**. One figure, two definitions, split by runtime
— which is the shape this milestone keeps finding, and fixing B5 without this would have moved
it rather than closed it.

`FiredEvent.pelletsHit` replaces the bit, in six spare bits of the byte the tracer flag already
rides, so nothing on the wire got bigger. The *denominator* is deliberately not replicated: it is
`WEAPON_DEFS[weaponIndex].pellets`, and both sides compile against that table. A derived field on
the wire is a second copy of a fact, which is what the bit was — `hitTarget` is now derived from
the count by the one consumer that wants it, for the tracer and the impact.

### Measured

Every number came out of a run in this session.

**`auditAccuracy` — `shared/debug/AccuracyAudit`, at the top of every harness run** beside
`auditRosterDeal` and `auditReplicatedScore`. Real `WeaponSystem`, real `Ballistics`, real
`DamageSystem`, a real frag through `EquipmentSystem`, and a real `ScoreSystem` on the same bus;
fixed seeds and targets that cannot move or die, so one run is a fact rather than a sample. Each
row carries both figures, because the fix is only legible as the pair:

| shape | weapon | pulls → rays | damage events | bodies | was | now |
|---|---|---|---|---|---|---|
| multi-pellet | `shotgun_breacher` | 6 → 48 | 46 | 1 | **767%** | **96%** |
| penetration | `ar_carbine` | 30 → 30 | 30 | 1 | 100% | 100% |
| penetration-control | `ar_carbine` | 30 → 30 | 27 | 1 | 90% | 90% |
| explosive | `ar_carbine` | 30 → 30 | 16 | **3** | 53% | 43% |

The penetration row is the one where the two figures are equal, and that equality is the finding:
that shape never inflated. The explosive row's ten points are three bodies a frag caught and no
round was fired at.

**The red control, on the tree as it stood.** P0's standing lesson is that an assertion which has
never been watched fail is not an assertion. With `ScoreSystem`'s two handlers put back the way
they were, the audit exits **1** with two problems: `multi-pellet: 46 hits out of 6 shots — 767%`
and `explosive: the row reads 53% where the damage-event figure is 53%`. Both were wrong first:
the explosive assertion originally compared `damageEvents` against `shotsHit`, which is a
proposition that only holds *after* the fix, so it went red on the broken tree for the rig's
reason rather than the code's. It asserts the two figures must differ now, which is the property
and not a proxy for it.

**`npm run harness --bot-weapon shotgun_breacher`, three matches, the same three seeds on both
trees.** The flag is new and is what B5's verification asks for: a statistic about rays per pull
measured on a roster that is one shotgun in eight is a statistic about carbines.

| | rows over 100% | worst row | RECRUIT | REGULAR | HARDENED | VETERAN |
|---|---|---|---|---|---|---|
| before | **9, 10, 10** of 10 | **261 / 310 / 271 %** | 1.12 – 3.00 | 2.21 – 2.47 | 2.44 – 2.52 | 2.28 – 2.61 |
| after | **0, 0, 0** | 32.6 / 38.8 / 33.8 % | 0.14 – 0.38 | 0.28 – 0.31 | 0.30 – 0.31 | 0.28 – 0.32 |

The prediction written before the run was that every tier's pre-fix rate would exceed 1.0 and
that the post-fix figure is bounded by 1.0 by construction. Both held. The worst row before is
**310%**, which brackets the report's 267% — the same defect, a different roster.

Two details in that table are worth more than the headline. In match 1 the RECRUIT tier read
`91 hits / 81 pulls` before and `91 hits / 648 rays` after: 648 is exactly 8 × 81, which is the
pellet count and nothing else. And REGULAR read 532 hits before against 529 after — the three
that went away are damage with no round behind it, which is the second half of B5 showing up in a
real match.

**`npm run harness`, five matches, the shipped roster:** every match `rowsOverHundred 0`, worst
row 18.1 – 30.3%, all five completed. `accuracy` is a new field on the per-match JSON, read off
`ScoreSystem.rows` rather than off the per-tier aggregate — B5 was a *row*, and one bot at 267%
disappears into a tier average.

**`npm run netharness` against a real `serve.js` on protocol v14:** 2 clients, 30 s, 600
snapshots each, **0 snapshots lost**, worst misprediction p99 **0.25**. The new field is in that
line and is worth reading: `shotsFired 102, shotsHit 4, hitsDealt 4, hitRate 0.039`. The two
numerators are equal because a headless client carries a carbine and threw nothing — which is
"agree by luck" as a measurement rather than as an assertion.

**The rest of the gate.** `npm run check` green, including the boundary, cosmetic and authority
audits. `npm run skirmish` **FLOW CHECK PASSED**, 3 clients, one migration each, **divergence
0/7372** on all three, 0 misrouted. `npm run leak` 100 cycles, subscriptions 29 -> 29 (+0), heap
13.14 -> 13.82 MiB (+0.68), **LEAK CHECK PASSED**.

### What was not verified

- **No browser saw any of this.** Every number above is headless. The post-match board and the
  Tab scoreboard both read `accuracy()`, which cannot now exceed 100 by construction, but that
  the column renders what the row holds is a claim about `EndOfMatch` that this session did not
  test.
- **The report's own 267% was not reproduced against the deployed build.** The shape is
  reproduced — 767% in the audit, 310% in a real match — and the mechanism is the one the brief
  named, but that is not the same evidence as the number in the report and it would be dishonest
  to present them as one.
- **`SentryGun` and `ChopperGunner` keep their own counters and they are not asserted anywhere.**
  Each `stepFiring` sends exactly one ray and counts it, which is the same definition, but it is
  the same definition by reading rather than by call. They are the turret's numbers on the
  turret's panel and after this change they cannot enter a player's row: the only writer of a
  `PlayerScore`'s shot counters is the `weapon.fired` handler.

### Verified by eye, in a real browser

The build was refreshed onto protocol v14, a match played with a shotgun class, and the ACC
column read under 100 throughout; the post-match board was reported correct. That closes the
first of the three checks below — the one this session could not do for itself, because the
column is drawn by `EndOfMatch` and no harness builds one.

### Needs a browser

- **A networked match with a second window, one of them on a shotgun.** This is the half only a
  browser reaches: the local player's own shots are counted from a locally emitted event and the
  remote player's from the wire, and protocol v14 is what makes those two the same figure. Read
  the shotgunner's ACC on *both* screens and confirm they match.
- **Create-a-Class after that match.** The per-weapon accuracy under the weapon list comes from
  `Profile.weaponAccuracy`, which was already right; it should now agree with the scoreboard
  instead of disagreeing with it.

### Found while here

- **`MatchProgression` and `ScoreSystem` count the same statistic twice, and now agree.** They are
  still two tallies with two lifetimes — one per match, one per weapon, folded into the save — and
  that is deliberate. What is worth recording is that they were the same arithmetic written twice
  and only one of them was right, for a milestone, on adjacent screens.

## Playtest round 5 — a match that was played, and a table with no row for having played it

**B6** was a whole match — 0 kills, 6 deaths, a loss — paying `+0 XP`, the breakdown panel under
the bar rendering as an empty box, and the menu behind it still saying "500 XP TO NEXT" with the
bar on zero. The game's answer to a full match was that it had not happened.

### One mechanism, and the panel is downstream of it

Every one of the ten rows in `XP_SOURCES` was contingent on succeeding. `buildLines` skips any
row whose count is zero, so a player who did nothing produced **no rows at all** — and
`XpSummary.play` read `report.lines.length === 0`, jumped straight past its `'ROWS'` phase to
`'BAR'`, and left the rows container empty. The empty box was not a rendering fault; it was the
renderer faithfully drawing nothing, because there was nothing.

So it is one defect and not two, and the brief's second ask follows from the fix rather than
needing its own: give the table a row that always fires and the panel can no longer be empty.

### The rule, and it is two rows rather than a special case

`matchComplete` — flat, 500 — for reaching the end of a match. `matchTime` — 25 a minute — so a
long match pays more than a short one. Both are ordinary rows in `XP_SOURCES`, which means they
sum, animate and display through exactly the same code the other ten do; nothing at the summing
site knows they exist. `MatchProgression.finish` sets their counts beside the four it already
sets for assists, objectives, weapon levels and challenges.

500 is not a new number. **A dedicated server has been paying `MATCH COMPLETE` 500 since M11** —
as a literal, in `LiveMatch.buildXpLines`, next to a table whose own file comment says *"the whole
award table is here and nothing downstream hardcodes a value"*. It was hardcoded downstream, so
the rule B6 asks to be built already existed in one runtime and not the other, with its number in
the wrong place. Keeping 500 means making one table authoritative is not also a balance argument.

25 a minute is deliberately the smallest per-unit award in the table except a headshot: ten
minutes of standing still pays 250, which is less than three kills.

### The two edges, decided rather than defaulted

**Leaving early pays nothing, and nothing had to be built for it.** XP is banked from `Game`'s
entry into the `SUMMARY` state, so a client that quit at 30 seconds never reaches a path that pays
it. The completion condition *is* the call site. That matters, because the alternative — a "did
they finish" flag — is exactly the sort of state that goes out of step with a reconnect.

**The per-minute term is the match's length, not the player's stay.** One clock:
`ServerMatch.tickCount` on a server, `MatchProgression`'s own per-tick sampler in single-player. A
returning player therefore cannot lose the minutes before their drop, because those minutes were
never counted per player in the first place — there is nothing for a reconnect to have to survive.
The alternative, per-seat occupancy, would have needed bookkeeping that does not exist:
`ReclaimedSeat` carries an entity id and a team and nothing else, and the `NetPlayer` a returning
client gets is a new one.

**The warmup arena cannot pay, structurally, and both halves were traced rather than assumed.** A
summary is built by `LiveMatch.buildSummary`; `WarmupMatch` has no such method, so the room emits
none. On the client, `Game.applyRotation` calls `teardownWorld` before building the live world, so
the live match gets a `MatchProgression` constructed at zero rather than one carrying the room's
minutes. That is why `MatchXpAudit` has no arena case: asserting a zero against a call that cannot
happen is a green light with no bulb behind it, which is this file's standing lesson about
unreachable guards. `npm run skirmish` reports the room's own numbers, and it reports `score rows
0` in it.

### The panel cannot be handed an empty tally, and that is a type

`XpReport.lines` is `readonly [XpLine, ...XpLine[]]` now. `buildLines` returns
`[matchFloorLine(), ...rest]`, which is the shape the compiler reads as non-empty, so the
guarantee is structural rather than a convention somebody has to keep. `XpSummary.play`'s
empty-list branch is gone because it is unreachable.

Two things fell out of that, and both are improvements the type forced:

- **`emptyXpReport` is deleted.** Its only caller was `finish`'s idempotence guard, which returned
  a report of zeroes on a second call. That is not idempotence, it is a lie told the second time —
  the match did pay something. `finish` caches what it produced and hands the same answer back.
- **`Game.bankServerXp` sums the lines rather than the wire.** It used to total `net.xp` and then
  separately map it into rows; now the rows are built first and the total is their sum, so what
  the bar animates and what the profile banks cannot come apart. Its floor fallback is the same
  `matchFloorLine` single-player uses, so an empty `xp` array off the socket produces the same
  answer as an empty match does locally.

### Measured

Every number came out of a run in this session.

**`auditMatchXp` — `shared/debug/MatchXpAudit`**, at the top of every harness run beside
`auditAccuracy` and `auditReplicatedScore`. A real `MatchProgression`, sampled by a real
`WeaponSystem` and `PlayerController`, against a real `ScoreSystem`; nobody fires and nobody
scores, which is the harshest reading of the report:

| shape | ran | minutes | paid | lines | breakdown |
|---|---|---|---|---|---|
| worst | 360s | 6 | **650** | 2 | `Match complete x1 = 500`, `Time played x6 = 150` |
| short | 30s | 0 | **500** | 1 | `Match complete x1 = 500` |
| played | 600s | 10 | **750** | 2 | `Match complete x1 = 500`, `Time played x10 = 250` |

**The red control, on the table as it stood.** With the floor demoted to an ordinary row and the
time count not set — which is the code exactly as B6 found it — all three shapes read `0 XP over 0
line(s)` and the audit exits **1**. That is the report reproduced as a number: the empty panel and
the zero are the same fact, which is why one row fixes both.

**The audit found a real defect in this session's own fix, on its first run.** It prints the
minutes it asked for beside the minutes the row awarded, and they disagreed: `played 600s` came
out as `10 min` in the header and `Time played x9` in the line. `secondsPlayed` was accumulated as
`+= DT` once a tick; `DT` is `1/60`, which no float holds, and thirty-six thousand of them sum to
**599.999999999783** — under the minute boundary, so a ten-minute match paid for nine. It drifts
both ways: 21600 ticks sum to 360.00000000000125. Counting ticks as an integer and multiplying
once has no drift to accumulate. The assertion that caught it is now permanent.

**`npm run skirmish` with `MATCH_ROUND_SECONDS=90`** — the default run never ends a match, so the
summary path is not reached and the brief asks for the XP at the end. Three clients, two cycles,
twelve migrations, **`FLOW CHECK PASSED`**, six summaries received:

    OP1 XP: 875 over 4 row(s) — MATCH COMPLETE 500, TIME PLAYED 25, WIN BONUS 250, TOP OPERATOR 100
    OP2 XP: 875 over 4 row(s) — MATCH COMPLETE 500, TIME PLAYED 25, WIN BONUS 250, TOP OPERATOR 100
    OP3 XP: 875 over 4 row(s) — MATCH COMPLETE 500, TIME PLAYED 25, WIN BONUS 250, TOP OPERATOR 100

`TIME PLAYED 25` is one minute, and it is one minute **because the round was shortened to 90
seconds to reach the summary at all**. That is the knob in the number, stated rather than left for
a reader to trip over: an authored round pays the authored length. The identical row set across
three clients is not a coincidence and is the finding below.

**The economy, since this is a balance change and should be stated as one.** Against
`XpSimulator`'s `AVERAGE_MATCH` — 18 kills, 5 headshots, 6 assists, 2 longshots, a best streak of
4, half the matches won, a fifth topping the board — a ten-minute match moves from **3120 to 3870
XP, +750, +24%**. A match with nothing in it moves from 0 to 750. The floor is a quarter of an
average match, which is the ratio the two numbers were chosen against.

**The rest of the gate.** `npm run check` green. `npm run harness` five matches, all completed,
`rowsOverHundred 0` on every one, so P3's assertion still holds under this change. `npm run leak`
100 cycles, subscriptions 29 -> 29 (+0), heap 13.14 -> 13.84 MiB (+0.70), **LEAK CHECK PASSED**.
`npm run netharness` against a real `serve.js`, 2 clients, 30 s, worst misprediction p99 0.731.

### What was not verified

- **No browser saw the summary screen.** The panel is non-empty by type and the totals are
  headless facts, but that the rows *animate* — `XpSummary` steps them on `requestAnimationFrame`
  over a torn-down match — is untested by anything here, and P0's split says the preview pane
  cannot stand in for it.
- **The reconnect case was reasoned, not run.** `npm run skirmish -- --drop-return N` exercises
  drop and return, but the default cycle never ends a match, so a returning client has no summary
  to be paid by. The claim — that a returning player keeps their minutes — rests on the award
  being the match's length rather than the seat's, which is a property of where the number comes
  from rather than a measurement. A drop/return **and** a shortened round in one pass is the test,
  and it was not run.
- **The `matchTime` value is unplaytested.** 25 a minute is an argument about proportion, not a
  measurement of how it feels to earn.

### Verified by eye, in a real browser

A deliberately bad match was played through to the summary: the base completion award and the
time-played row were both there, the total was not zero, and the panel had rows in it rather than
the empty box. That closes the first of the checks below — the one no harness here can make,
because the rows are animated by `XpSummary` over a torn-down match.

### Needs a browser

- **A sub-minute match.** Leave a solo match immediately after it starts: the panel should show
  `Match complete` alone, rather than a `Time played x0` row reading zero.
- **The menu behind it.** The bar should have moved, and "500 XP TO NEXT" should no longer be the
  answer to a match that was played to the end.

### Found while here

- **`LiveMatch.buildXpLines` builds one array for the whole instance, and every seat gets it.** The
  comment above it said *"the per-player half is filled in by the caller, which knows which row
  belongs to which client"* — there is no such caller: `Server.finishLive` builds the summary once
  and sends the same object to every session. So `WIN BONUS` is paid to the losing team and `TOP
  OPERATOR` to everybody, which the skirmish run above shows as three identical XP lines for three
  clients. Same class as B7's comment describing a check the code cannot perform, and the comment
  has **not** been left standing: `buildXpLines` now says plainly which of its rows are the
  table's and which are not. The fix is not here, because making the lines per-player means
  reconciling the win bonus and MVP with `win` (500) and `mvp` (300) in the table, which they
  disagree with in both name and value — a change to the networked economy rather than to B6.
- **A dedicated server pays nothing per kill.** Its whole breakdown is those four flat rows, so a
  30-kill match on a server pays 875 where the same match in single-player pays over 3000. A much
  larger disagreement than B6, and deliberate scope: closing it means deciding whether the
  instance should score the client's progression at all, which is the next thing to decide about
  §6.9.
- **`WeaponTally.timeUsed` still accumulates `+= DT` per tick**, with the drift measured above. It
  is a per-weapon lifetime stat rather than a threshold, so a few hundredths of a second across a
  match crosses nothing — but it is the same arithmetic, and if a rule is ever hung off it the
  first thing to do is count ticks instead.

## Playtest round 5 — a public interface with three copies and no check

**B9** was two documented URL flags not doing what `README.md` says: two clients opened with
`?name=BRAVO` and `?name=ALICE` both joined as `OPERATOR-013`, and `?server=1` left the game in
the menu until `PLAY MULTIPLAYER` was clicked by hand.

Only one of those is a defect, and neither is a parsing bug.

### `?name=` was read, discarded, and documented as a feature

`parseJoinOptions` read `params.get('name')` and built a `HandshakeOptions` around it.
`multiplayerJoinOptions` — its **only** caller — spread that object and replaced `displayName`
with the profile callsign on the very next line. So the parse was dead code, and the dead code
was the thing `README.md` described.

That shape is the finding rather than the line: a second entry point whose whole purpose was to
overwrite the first. It is the same smell as round 5's B7 — *a shared class with one caller is
not shared, it is misfiled* — and it is why the fix is one function rather than a corrected line.

### `?server=1` was never broken, and the prose was

There is no auto-connect path and there never has been. `isServerConfigured` enables the Play
Multiplayer button and nothing else; `Game.playMultiplayer` is reached from that click and from
no other call site. The README's *table* was accurate — the flag says which address — and the
*prose* around it (*"open the client with a `?server=` flag"*) is what promised a connection.

**The decision, made explicitly: no auto-connect.** `VITE_SERVER_URL` is baked to `1` on the
deployed build, so a flag that connected on sight would throw every visitor straight into a
socket and put Play Solo behind a disconnect. §6.1's flow is menu-first by design. The README is
what changes, and it now says so in a sentence rather than leaving it to be inferred:
*"The flags choose an address; they do not connect."*

### The precedence, decided and recorded: URL over profile

Not on taste. `parseJoinOptions` already documented a ladder for the address — *"`?server` wins,
then the build-time `VITE_SERVER_URL`, then the page's own origin"* — an explicit per-session
instruction beating a stored default beating a generated one. `?name=` gets the identical ladder:
**URL, then profile callsign, then `OPERATOR`.** One parser resolving two flags in opposite
directions is the disagreement this session exists to remove, and it is how `?name=` came to be
read, discarded and documented all at once.

The argument for the profile winning — *"a stray URL should not silently rename them"* — does not
survive contact with what a URL override actually is: nothing is written back, the profile is
untouched, the override lasts as long as the tab and the cause is visible in the address bar.
`resolveDisplayName` reads the profile and never writes it, and the audit asserts that rather
than leaving it to prose. The README's own developer workflow decides the rest: *"open it twice,
in two windows, with different names"* cannot work under any other precedence, because both
windows share one profile.

### The artefact: one declaration, and a check that fails

`shared/net/UrlFlags.ts` holds every flag this client understands — the documented ones as the
README's cells verbatim, and the undocumented ones as a map of key to the reason it is not
public, because "undocumented" is a decision and not a gap. `scripts/check-flags.mjs` is in
`npm run check` and asserts three things:

1. The README's table and `URL_FLAGS` agree row for row, cell for cell, in order.
2. Every documented flag names a key the client actually reads — the brief's ask in one sentence,
   *the next flag cannot be documented into existence without existing*.
3. Every key the client reads is declared, one way or the other.

**What it cannot catch, written into the script so nobody trusts it further than it goes:** a
flag that is parsed and then ignored is invisible to a grep, because the key *is* read and the
README *does* describe it. That is exactly what `?name=` was. So the behavioural half is
`shared/debug/UrlFlagAudit`, which runs the resolution for real and looks at what comes out. B9
needed both halves and neither would have found it alone.

### Three rules that existed twice, and one of them had already drifted

The flags carry rules the server shares, and they were duplicated:

- **`sanitiseName` existed character for character in two files** — `client/net/JoinOptions` and
  `server/net/Session` — the same loop over the same code points with the same cap, differing
  only in what each returned for an empty name.
- **The `#rw` suffix string existed three times**, in `Handshake`, `NetClient` and `net/Session`.
- **And the duplication had hidden a real bug.** The client capped the name at twenty characters
  and *then* appended `#rw`, producing twenty-three; the server sanitised the incoming name —
  capping it at twenty again — and only then asked whether it ended in `#rw`. The three
  characters carrying the answer were the three the cap had just removed, so `?rewinddebug=1` was
  **silently ignored for any callsign of eighteen characters or more**. The wire's string field
  holds 255 bytes, so the suffix never needed to be inside the budget at all.

All three live in `UrlFlags` now, and the server strips the suffix *before* the cap.

### A third flag that does nothing, found by tracing readers rather than by the check

`?rewinddebug=1` is documented as *"ask the server for the per-shot rewind feed"*. **There is no
such feed.** No message on the wire carries one; `NetPanel` computes all three of its Rewind
fields from the client's own RTT; and `Session.wantsRewindDebug` — the flag the entire chain from
query string to handshake to session exists to set — is **written and never read**, on the server
or anywhere else.

The plumbing is real and the destination is not. The key has moved into `UNDOCUMENTED_URL_KEYS`
with that reason attached, rather than being ripped out: `HandshakeOptions`, `NetClient` and
`HeadlessClient` all carry the request and it is what the feed will be built on. The row goes back
in the README the day something reads it.

`NetPanel`'s comment claiming the server sends the record has been rewritten. A comment describing
a feed the code cannot receive is what let this look finished for a milestone, and it is the same
finding B7 made about `ModeStateHash` — which is now twice in one round, so it is worth saying
plainly: **this project's most reliable bug detector is asking who reads a thing.** Two of B9's
three flags were found that way and neither was findable by a grep.

While there: the panel's `const interpMs = 100` is `DEFAULT_INTERPOLATION_DELAY_MS` now. A
read-out keeping its own copy of a replicated number is a read-out that lies the day the number
moves.

### Measured

Every number came out of a run in this session.

**`scripts/check-flags.mjs`, watched red three times before it was trusted green:**

| Red control | What it reported |
|---|---|
| Declaration unread | `README.md documents 7 flag row(s); URL_FLAGS declares 0` — and the cause was the check's own bug: `export const URL_FLAGS: readonly UrlFlag[] = [` has a `[` in the **type**, so brace-matching from the first bracket returned the empty pair. It went red for the right reason on the wrong evidence, which is why the bracket is now found after the `=`. |
| README drifted | The three effect cells this session deliberately rewrote, each printed with both texts and the README line number |
| Flag documented into existence | A fabricated `?spectate=1` row: *"documented but nothing under src/client/ reads `spectate`"* |

And a fourth, found by reading its own output: the first scan matched only `params.get(...)` and
`searchParams.get(...)`, so `?show` — read through an inline
`new URLSearchParams(window.location.search).get('show')` — was invisible to it. It reported **ok
over 11 of the 12 keys**. A grep that passes over what it cannot see is worse than one that
fails, so the check now counts every `new URLSearchParams` under `src/client/` and fails when it
cannot follow one. Green reads **12 keys across 116 client files**.

**`auditUrlFlags` — `shared/debug/UrlFlagAudit`**, at the top of every harness run beside
`auditAccuracy` and `auditMatchXp`. Eight name cases and four rewind round trips:

| case | `?name=` | profile | resolves to |
|---|---|---|---|
| url wins | `BRAVO` | `OPERATOR-013` | **BRAVO** |
| second window | `ALICE` | `OPERATOR-013` | **ALICE** |
| no flag | absent | `OPERATOR-013` | `OPERATOR-013` |
| empty flag | `""` | `OPERATOR-013` | `OPERATOR-013` |
| blank flag | `"   "` | `OPERATOR-013` | `OPERATOR-013` |
| no profile | absent | `""` | `OPERATOR` |
| control chars | `ALICE` | `OPERATOR-013` | `ALICE` |
| over-long | 32 × `A` | `OPERATOR-013` | 20 × `A` |

    short name, asked          sent "OPERATOR-013#rw"         -> "OPERATOR-013"         rewind=true
    name at the cap, asked     sent "OPERATOR-013-LONGEST#rw" -> "OPERATOR-013-LONGEST" rewind=true

**The red control, on the two rules as they stood.** With `resolveDisplayName` returning the
profile and the cap applied before the suffix, the audit exits **1** with six problems, including
the report verbatim:

    two windows with different ?name= values both resolved to "OPERATOR-013"
    name at the cap: ?rewinddebug=1 on a 20-character name came back as false

**The rest of the gate.** `npm run check` green, including the new flag audit. `npm run harness`
five matches, all completed, with P3's and P4's audits still green beside the new one. `npm run
leak` 100 cycles, **LEAK CHECK PASSED**. `npm run netharness` against a real `serve.js`, 2
clients, 30 s, **0 snapshots lost**, worst misprediction p99 0.701.

### What was not verified

- **`npm run netharness` cannot test `?name=` precedence, and the brief's suggested check is not
  available.** `HeadlessClient` takes a name directly and never traverses `JoinOptions`, which is
  client-only code; and it does not keep the roster's names, so "two clients appear on the
  scoreboard with distinct names" is not observable from that harness at all. The netharness run
  above proves the link is healthy and nothing more. Making it observable means replicating the
  scoreboard's names to a headless client, which is a wire question rather than a flag question.
- **No browser opened two windows.** The precedence is a headless fact about a pure function; that
  two tabs of the real client show two names on one scoreboard is the thing only a browser can
  say, and it is the check the README's own workflow rests on.
- **`?net=` and the `?server=host:port` form were not exercised end to end.** They are unchanged
  by this session and now checked for existence, but neither was run.

### Verified by eye, in a real browser

Two windows were opened with `?name=ALICE` and `?name=BRAVO` and the scoreboard carried both
names, distinct, neither of them the profile callsign; the callsign in Settings was unchanged
afterwards. That closes the first two checks below — the precedence *and* the "nothing is written
back" half, which is the safety argument the whole decision rests on and which no headless run
can observe, because the profile is a browser store.

### Needs a browser

- **The menu with and without an address.** With `?server=` the Play Multiplayer button is
  enabled and *does not connect until pressed*; with neither `?server=` nor `VITE_SERVER_URL` it
  is disabled with the reason in its tooltip.

### Found while here

- **`Session.wantsRewindDebug` has no readers**, which is the sharper statement of the rewind
  finding above. The whole `?rewinddebug=1` chain — query string, `HandshakeOptions`,
  `withRewindSuffix`, the wire, `readIncomingName`, the session field — terminates in a boolean
  nothing consults. Building the feed is a protocol change and a feature; it is not B9.
- **`HeadlessClient` never learns anybody's display name.** It tracks entity ids, teams, scores
  and hashes, but no roster names, which is why the netharness check above could not be written.
  Worth knowing before the next session assumes a name is observable headlessly.
- **`BotHarness` owns seven undocumented query keys** (`harness`, `bots`, `speed`, `tier`, `map`,
  `mode`, `matches`) and the layout probe owns one (`show`). All eight are declared now with
  reasons. None is a defect; the point is that the client understands twelve query keys and until
  this session four of them were written down.

## Playtest round 5 — capabilities the game assumes, and the two answers that are not the same answer

**B8**: pointer lock is refused, `Input` writes `[Input] pointer lock request rejected:
WrongDocumentError` to the console, and the match runs on unaimable — full HUD, running clock,
nothing on screen. **F1**: there is no touch input anywhere in `src/client/`, and yet a phone
loads the menu, is shown a table of keyboard bindings and a note about F11, and can start a
match. One missing step twice: the game never asks whether it can be played here, and never says
so when it cannot.

### The decision, and it splits — which is the finding rather than a compromise

The brief asked for one answer: is a refused pointer lock a banner or a blocking state. It is a
banner, and the reason is a property the two reports do not share.

**A refusal is recoverable, and it is the expected state on the commonest path in the game.**
`Input.armPointerLock`'s own comment records why the arming exists: Chrome refuses a lock for a
window after the player leaves it with Escape, so *pause, then resume* is a refusal every single
time. It clears itself the instant the next click lands. Blocking on that would be a modal the
player fights through on every resume — a protective answer applied to a condition that does not
need protecting from.

**No fine pointer is not recoverable by anything the player can do in the page.** No amount of
clicking gives a phone a mouse. Round 4's F7 made the protective call for the waiting room, and
*this* is where that precedent belongs.

So the rule is **recoverable conditions get a banner, unrecoverable ones get a gate**, and B8 and
F1 land on opposite sides of it for a stated reason rather than by taste.

### Surviving a pause and a rejoin is what choosing the banner buys

It is not extra work under that decision. The banner's visibility is a pure function in
`shared/ui/Capabilities`, called from `shared/ui/HudSurfaces` and evaluated once a frame by
`Game.updateHudSurfaces` — which is round 4's HUD surface invariant, and the brief was right that
this belongs *in* that table rather than beside it. Two consequences fall out for free:

- **A pause.** `PAUSED`'s enter calls `armPointerLock(false)`, so `wantsPointerLock` is false and
  the banner is down — correctly, because a released cursor on the pause screen is the player's
  own doing. On resume the arm re-requests and the banner returns only if the refusal does.
- **A rejoin.** The three terms come off `Input`, which `Game` owns rather than the world. Unlike
  every other field in `HudSurfaceState` they do not go `undefined` between a teardown and the
  next build, so a rotation or a migration cannot lose the fact. Nothing had to be remembered
  across either.

### One flag that meant two things, and a second refusal path that recorded nothing

`lockRejectedWhileArmed` could not have been read as a condition even if something had tried. It
carried two meanings — *we were refused* and *stop filling the console with it* — and
`onMouseDown` cleared it before every retry so the next refusal would log again. It was therefore
false for exactly as long as anybody would want to read it.

It is `lockRefused` now, with one meaning, cleared on **acquiring** the lock rather than on
attempting to, so it describes an outcome instead of an attempt. The console suppression rides
the same field and became once per armed session, which is what the old comment said it wanted.

And there were **two** ways a refusal arrives, of which only one recorded anything.
`requestPointerLock` returns a rejected promise on Chrome 113+; every browser also fires
`pointerlockerror` on the document, and that handler logged and set nothing. On a build that
returns `undefined` from the request the refusal was invisible even inside `Input` — so B8's
banner would have been silently absent on exactly the browsers most likely to refuse. Both paths
go through `noteLockRefused` now.

### F1 is a gate, and the gate is *not reaching the menu*

`BOOT`'s enter shows a message and transitions to `MENU` on a 32 ms timeout. The check goes
there, and when it fails the transition simply does not happen: there is no button to disable, no
state to be in, and nothing downstream has to know. It needs no `GameStateId`, no entry in
`LEGAL_TRANSITIONS`, and no interaction with the pause or summary machinery a real state would
have dragged in for a screen nobody can leave. The loop is left running on purpose — it is what
composites the screen.

F1 asked for *"the honest version — a screen that says the game needs a keyboard and a mouse"*
and explicitly **not** a half-built touch scheme. That is the whole feature.

### Touch is not the test, and that is the row worth defending

The obvious reading of *"there is no touch input"* is to gate on `navigator.maxTouchPoints`. It
is wrong, and wrong in the direction that matters: a laptop with a trackpad **and** a touchscreen
reports a non-zero touch count and a coarse pointer alongside its fine one, and it plays
perfectly well. The question is not whether the device has a finger; it is whether it has
something to aim with.

So the rule is **a fine pointer, and an API to lock it**. The audit carries a `touchscreen
laptop` row for no other purpose than to hold that decision in place, and it was watched failing
against the naive rule before it was trusted — see below.

### Measured

Every number came out of a run in this session.

**`auditCapabilities` — `shared/debug/CapabilityAudit`**, at the top of every harness run beside
`auditAccuracy`, `auditMatchXp` and `auditUrlFlags`. P6's verification asks for exactly this:
*"the capability predicates are pure functions of `navigator`/`document` state and are tested as
such, without a DOM."* The DOM half is one adapter that fills a record in; everything that
decides anything takes the record.

| shape | touch | fine | coarse | lock | verdict |
|---|---|---|---|---|---|
| desktop | 0 | y | n | y | **PLAYS** |
| touchscreen laptop | 10 | y | y | y | **PLAYS** |
| phone | 5 | n | y | n | `no-pointer-lock` |
| tablet with pointer lock | 5 | n | y | y | `no-fine-pointer` |
| desktop, no lock API | 0 | y | n | n | `no-pointer-lock` |

The aim warning is a function of three booleans, so **all eight** combinations are swept rather
than the two anybody would think to write — **1 of 8 raises the banner**. That is not
thoroughness for its own sake: the case that has to be run is `refused` true with the lock
*disarmed*, because "the banner must not fire while paused" is the whole decision, and asserting
it needs the case rather than the intention.

**Two red controls, both watched before the green was trusted.**

| Control | What it reported |
|---|---|
| The code as it stood — no gate, and a refusal that told nobody | exit **1**, four problems: three device shapes returning `ok`, and `wants=true locked=false refused=true gave false, expected true` |
| The naive reading of F1 — gate on `maxTouchPoints > 0` | `touchscreen laptop: playability returned "no-fine-pointer", expected "ok"` |

The second is the one worth having. It is the mistake this session would have made without the
row, and it locks a working machine out of the game.

**`npm run layout` — the gate screen in a real headless Chrome**, because P0 rule 7 is explicit
that a layout claim which can be a rect should be one, and because the only viewport this screen
is ever shown at is a small one. A message saying *your device is too small to play* that is
itself cut off would be a joke at the player's expense.

    unsupported              content 322x195          ok      (at 375x812)

11 surfaces across 6 viewports, **PASS — every surface fits or scrolls**.

**The rest of the gate.** `npm run check` green. `npm run harness` five matches, all completed,
with P3's, P4's and P7's audits still green beside the new one. `npm run leak` 100 cycles,
subscriptions 29 → 29 (+0), heap 13.16 → 13.86 MiB (+0.70), **LEAK CHECK PASSED**. `npm run
skirmish` **FLOW CHECK PASSED** — run because `HeadlessClient.observeSurfaces` gained three
fields, and it is the probe that exercises the surface rules over a real connection.

No wire change and no simulation change, so the protocol version is untouched.

### What was not verified

- **No browser saw either surface behave.** The layout probe mounts the gate screen and measures
  it, which is a rect and not a behaviour: that the screen is what a *phone* actually reaches is
  a browser claim, and so is every frame of the banner.
- **The banner is structurally silent in every headless run, and the harness says so.**
  `HeadlessClient` has no pointer to lock, so its `HudSurfaceState` carries
  `wantsPointerLock: false` — written as a stated limit in that record rather than left as a
  default somebody could read as a pass. The rule is exercised by the audit; the *wiring* from
  `Input` through `Game` to the HUD is not exercised by anything here.
- **`readDeviceCapabilities` is the one file in the feature that cannot be tested headlessly**,
  by design. Its fallbacks — a `matchMedia` that throws, a `maxTouchPoints` that is `undefined` —
  are reasoned rather than measured, and the reasoning is in the file.

### Verified by eye, in a real browser

The desktop pause/resume cycle was run and is clean — no banner flash on the way back in, which
is the case the predicate's third term exists for and the one a headless run cannot reach. The
mobile emulation was confirmed to block entry at the boot screen outright. That closes the first
and third of the checks below; the middle one, a genuinely refused lock, is still open.

### Needs a browser

- **A refused lock.** Open the built client inside an `<iframe>` on a local page — an iframe
  without `allow="pointer-lock"` is refused, which is the `WrongDocumentError` the round-5 report
  hit. Start a match: the red banner reads `MOUSE NOT CAPTURED — CLICK TO AIM · F11 FOR
  FULLSCREEN` above centre and stays up. Pause: it goes down. Resume: it comes back. Fix the
  iframe permission, reload and click: it clears on the frame the lock lands.
- **A mobile-emulated viewport.** DevTools device toolbar, 375×812, with touch emulation on —
  the emulated viewport alone is not enough, because the rule is about pointers and not about
  width. Reload. The gate screen appears instead of the menu, there is no Play button anywhere on
  it, and the console carries one `[join] refusing to start: no-fine-pointer` line.

### Found while here

- **`Input.onPointerLockError` recorded nothing before this session**, which is the second
  refusal path above. Worth restating on its own because it is the same shape as round 5's other
  two findings: a handler that exists, runs, and terminates in nothing. Three times in one round
  now — B7's score comparison, B9's `wantsRewindDebug`, and this — and the detector each time was
  *asking who reads it*.
- **The device gate cannot be reached from the layout probe's own harness path.** The probe
  imports `playability` and mounts the screen directly; there is no way to make `Game`'s boot
  check fail on a desktop, so the *branch* is untested even though the screen is measured. A
  `?device=` override would test it and would also be a way to skip the gate, which is why there
  is not one.
- **`Menus.showUnsupported` is the second terminal screen in the front end**, after
  `showBoot('NO SERVER CONFIGURED — …')`. Neither is a state, both are `.op-screen` with the menu
  never painted over them, and if a third appears it is worth asking whether they want to be one.

## Playtest round 5 — reading a hit, and two marks drawn for a dark game

**F3**: the impact decals are soft black blobs 30-40 cm across, reading as holes punched through
a wall rather than as bullet strikes. **F5**: the crosshair is clear on Foundry and nearly
disappears on Dunes at noon.

One job, and one shape behind both: **every mark the game draws to tell you about a shot was
tuned against a dark backdrop, and the game has two bright ones.** Dunes' sand reads 185/255 and
Depot's asphalt reads 21 — a factor of nine between two maps in the same rotation.

### F5 is not a matter of taste, and the probe already had the ground values

The brief named the fix and it is right, but the argument is better than "a hard ring is
crisper". A 2px *blurred* shadow spreads its darkness over four pixels of a two-pixel mark, so
almost none of it reaches the pixel adjacent to the line; on a dark map the ground supplies the
contrast anyway and nobody notices. `npm run readability` has been measuring what each map's
ground reads at since round 4, so the report converts straight into a number:

| ground | 0-255 | mark vs ground | mark vs hard ring |
|---|---|---|---|
| FOUNDRY | 61.7 | 7.58 : 1 | 14.04 : 1 |
| DEPOT | 21.3 | 12.36 : 1 | 13.98 : 1 |
| DUNES | **185.0** | **1.56 : 1** | 13.56 : 1 |

1.56:1 is below WCAG 2.1's 3:1 floor for a non-text UI component — *"it nearly disappears"* as a
figure rather than an opinion, on exactly the map that was reported and no other.

**The property worth having is not that the number went up.** It is that a ringed mark is
compared against an opaque ring rather than against the map, so the figure stops depending on the
map at all: the spread across the three grounds collapses from **7.94× to 1.04×**. That is what
makes the crosshair stop being a per-map problem, and it is why the same token now drives the
hitmarker — which had the identical shadow, the identical problem, and matters more because it
is the only confirmation a shot connected and it is on screen for a fifth of a second.

The blur is kept *behind* the ring rather than replaced by it: the ring supplies the guaranteed
floor and the blur supplies depth, doing the thing a blur is actually good at instead of the
thing it was failing at.

### F3's two claims: one right about the wrong number, one simply wrong

**The decals were too big, but not the way the report says.** The quad is
`decalRadius * 2 * jitter` across, and what the eye reads is the texture's pale rim at 0.96 of
it — so the *visible mark* ran 7.3 to 25.3 cm, with sand the worst. The reporter's "30-40 cm" was
the rim seen close up, not the quad and not the hole.

**"the puff is what sells it, and it is what is missing" is false.** `Fx.spawnImpact` has
launched a dust puff on every strike since M5: 3-8 particles, 3 cm, dead in 0.24-0.46 s. It was
not missing. It was **outsized by a decal eight times its width**, which is a different defect
with a different fix — and the fix is the one already being made. Shrinking the mark is what
makes the existing puff read, so no particle count changed and the particle budget did not move.

That is the third brief claim this round to die by measurement rather than get implemented, after
B5's penetration and B9's `?server=1`, and the method was the same each time: look before
believing.

### The sizes are chosen against a target, and the target is in the file

`decalRadius` used to be sixteen numbers with no stated unit beyond "metres" — and a radius in
metres means nothing on its own, because what is visible depends on where the texture paints its
hole and its rim. Those two fractions are declared beside the field now
(`DECAL_HOLE_FRACTION`, `DECAL_RIM_FRACTION`), `buildDecalTexture` paints from them instead of
its own literals, and the sixteen values are chosen so the rim lands in a **stated 5-12 cm range**
that lives in the same file and is asserted by the probe. The per-material spread is deliberately
kept: a round spalls wider out of plaster than out of steel grating, and flattening that would
trade one wrong picture for another.

### The decal cap: a comment that had been wrong since the LMGs landed

`CAPACITY = 192`, with a comment saying it *"holds two full magazines of the largest-magazine
weapon in the arsenal"*. It does not. The MONOLITH's magazine is **125**, so two is 250 — and the
extended-magazine attachment multiplies by 1.5, so the largest magazine anybody can assemble is
188 and two is **376**. The constant had been describing a rule it did not implement since the
day the LMGs shipped.

The brief asked for the cap to be derived or justified. It is derived: `2 * largestMagazine()`,
computed at module load over `ALL_WEAPONS` and `ATTACHMENT_IDS`. The next weapon or attachment
that moves the ceiling moves the pool with it, and the comment cannot go stale because there is
no number left in it to be wrong.

**The frame-cost note F3 asks for:** 192 → 376 buys 184 more instance matrices, about **13.7 KB**
of `Float32Array`, and **zero** extra draw calls, state changes or per-frame work. The field is
one `InstancedMesh` however full it is, nothing iterates the pool per frame, and `place` writes a
single slot.

### Measured

Every number came out of a run in this session. All of it is a pure function of the shipped
tables, so one run is a fact rather than a sample.

**`npm run readability`** gained both halves, printed above, and now exits non-zero on either.
That is a change to what the probe is entitled to do, and it is argued rather than assumed: the
file's own note says a reading with no agreed threshold must not fail a build. These two have
thresholds somebody can point at — WCAG's 3:1, and a target range written down beside the values
it governs — so an edit that leaves them has to argue with a number instead of with a taste.

**Two red controls, run independently so each failure is attributable to one assertion:**

| Control | What it reported |
|---|---|
| The crosshair with no ring reaching the adjacent pixel | `DUNES 185.0 1.56:1 1.56:1 UNDER 3:1` — exit **1** |
| Sand's `decalRadius` back at 0.11 | `sand 0.110 8.2-11.6 18.0-25.3 OUTSIDE` — exit **1** |

The second is the report's own number: 25.3 cm of visible mark, which is what "30-40 cm" was
looking at.

**The decal table after**, all sixteen materials inside the range, holes 2.3-5.5 cm and rims
5.1-12.0 cm. Sand, the worst offender, went from a 18.0-25.3 cm mark to 8.5-12.0 cm.

**The rest of the gate.** `npm run check` green, **cosmetics audit green** — nothing here touches
a simulated value, and `decalRadius` has exactly one reader, in `client/engine/Fx.ts`. `npm run
harness` five matches, all completed. `npm run layout` 11 surfaces at 6 viewports, PASS. `npm run
leak` 100 cycles, subscriptions 29 → 29 (+0), heap 13.15 → 13.84 MiB (+0.69), LEAK CHECK PASSED.
No protocol change and no simulation change.

### What was not verified

- **Nothing was rendered.** Every number above is arithmetic over the shipped tables, and that is
  the honest limit of it: contrast is computed from the CSS colours and the probe's *upper bound*
  on ground brightness, and the decal sizes are computed from the quad and the texture's
  authored fractions. Whether the rim reads as a lip rather than a smudge is a claim about a
  canvas gradient that only an eye can settle.
- **The ground values are upper bounds, and that matters in one direction.** `MapLuminance`
  states its own limits — no shadowing, no baked AO, no fog — so a real Dunes is no brighter than
  185 and may be darker in places. The contrast figures are therefore worst-case for Dunes, which
  is the direction that makes the F5 claim safe, and best-case for Depot, which is the direction
  that makes a *pass* there weaker than it looks. Nothing rests on Depot's pass.
- **The puff was measured but not judged.** 3-8 particles at 3 cm for 0.24-0.46 s is what the
  code does; whether that reads as displaced material once the decal beside it is a third of the
  size is exactly the thing this session decided not to guess at.

### Verified by eye, in a real browser

All five checks were run and passed. The crosshair and the hitmarker hold on Dunes' bright sand
and in Depot's dark interiors — the two ends of the 7.94× spread the ring was chosen to collapse.
The particle puffs read as proportional now that the decals are a third of their old size, which
is the specific claim this session made instead of adding particles: the puff was never missing,
it was outsized. And the pool cycles through hundreds of rounds without a hitch, which is the
derived 376-instance cap doing what the arithmetic said it would.

### Found while here

- **`buildDecalTexture` painted its hole and rim from its own literals**, unrelated to anything
  that knew what a decal was for. They are `DECAL_HOLE_FRACTION` and `DECAL_RIM_FRACTION` in
  `materials.ts` now, next to the `decalRadius` they give meaning to — a metre value for a mark
  is uninterpretable without them, which is why the sizes could drift to 25 cm without anybody
  being able to say so.
- **The probe restates `DecalField.place`'s jitter as two constants.** A second copy, and the
  honest kind — a server entry cannot import a client module — but it is a second copy, and if
  the jitter moves the probe will silently report the wrong range. Worth a shared constant the
  day anything else needs it.
- **Four comments in this round have now described something the code does not do**: B7's
  score-versus-events comparison, B9's rewind feed and its per-player XP lines, and this one's
  two full magazines. Each was found by asking what the sentence would have to be true of, and
  checking. It is the cheapest audit in this project and nothing automates it.

## Playtest round 5 — what the HUD knew and did not say

**F8**: in Domination the top bar shows two scores and a timer, and which team holds A, B or C is
readable only from the minimap. **F9**: the death screen says `YOU WERE KILLED` and counts down,
while everything a player could act on sits in the killfeed, in the corner, for a few seconds —
in the opposite corner from where they are looking.

One omission twice: **the fact is already in client state and no surface asks for it.** Except
one, which turned out to be in state that is a snapshot too late to mean what it would say.

### F8 — the state was live, unlike the last time this looked familiar

The first thing to check was whether this was B7 again: a client reading a local copy of a fact
the server owns, getting a structural zero, and nobody noticing. It is not. `MatchWorld:419`
writes `owner`, `capturingTeam` and `progress` onto `mode.objectiveZones` from every replicated
`ObjectiveState`, so the ownership a Domination client holds is the server's and is current. The
minimap has been drawing it all along; nothing else asked.

So the work is a surface, and the artefact the brief asks for is *"not flags in the top bar but a
header slot the mode fills"*. `GameMode.headerSlots` is that, and it is deliberately the same
shape as round 4's `brief`: the mode says what it wants shown and the HUD draws whatever it is
handed, so the HUD knows the name of no mode and the next one gets a header without a new
component.

**Four fields and no more** — a label, an owner, a fill, and whose fill it is. The temptation is
a per-mode shape and it is wrong for the reason `brief`'s comment already gives: a HUD that knows
what a bomb is has to be edited when a mode is added, and the sixth mode is the one that gets
forgotten.

**`headerSlots` is a default returning empty; `brief` is abstract. That difference is a
decision.** Every mode owes the player a sentence about what they are here to do, so forgetting
one should be a compile error. Not every mode has a persistent header worth drawing — Kill
Confirmed's tags are loose objects with no owner and no progress — and forcing it to invent a row
would put something meaningless in the one strip that is always on screen.

Two modes fill it. Domination maps its flags. Search & Destroy maps its sites, where `owner`
means something deliberately different: a site is neutral until the bomb is on it and then
belongs to the **attackers**, because what a defender needs off a glance is not who is nearer it
but which one is now costing them the round, and `progress` is the fuse draining rather than a
capture filling. The HUD does not know which of the two it is drawing and does not need to.

**The colours are relative and go through `relationClass`.** A header keyed on the absolute team
would have been round 4's B12 for the fourth time — the palette was right and three surfaces
chose from it wrongly — so the cell asks what its owner is *to this viewer*, and the guard
signature is keyed on the relation rather than the team so a side swap at half-time cannot leave
a stale colour behind.

### F9 — three facts were free and the fourth was a trap

Killer, weapon and distance are all obtainable on the client. The killer's **remaining health**
is the one F9 singles out as the one that changes behaviour, and the brief was right to say
*check before you promise it*.

It is not on the wire's `KilledEvent` and it is not on `EV.EntityKilled`. But every entity's
health **is** replicated in the snapshot and sitting in `RemoteActor.health`, so it can be read —
and that is the trap rather than the answer. The snapshot is up to a tick and an interpolation
delay old and may already carry damage the killer took *after* killing you. "He had 8 health" is
a lesson about how close you came; the late version of that sentence says it about a fight you
lost cleanly, and on a busy server that is common rather than exotic.

**So it goes on the wire, stamped by the server at the instant of the kill (protocol v15).** One
byte, on an event that happens a few times a minute per player, against a number only the server
holds at the moment it is true. Producing a different number and calling it the same thing is
this milestone's recurring failure and it is not worth repeating to save a byte.

**Distance goes the other way and is derived locally**, and the contrast is the point: the
killer's interpolated position is stale by the same snapshot, which at a walking pace is well
under a metre on a figure printed as a whole number. Health can change by 100 in the time
position changes by half a metre. Same staleness, opposite conclusion, for a stated reason.

`DamageSystem.apply` is where the stamp is taken, because it is the only line in the game that
runs with both bodies in hand and the kill already resolved. A shooter that is not a `Damageable`
— a sentry, a mortar, a killstreak — has no health to report and gives 0, which the panel reads
as "not a person" and does not print.

### The panel drops what it does not have rather than padding it

`describeDeath` is a pure function so the sentence is testable without a DOM, and every field is
omitted when it has nothing to say:

    CINDER · M4 CARBINE · 42M · HEADSHOT · 8 HP LEFT
    SENTRY

A fall has no killer, a killstreak has no health, and `HEALTH 0 LEFT` about a sentry gun would be
worse than silence. This is read in a second and a half, three or four times a minute, so a
shorter line is read and a padded one is skipped.

It is built from `EV.EntityKilled` and **not** `EV.KillfeedEntry`, even though the feed line
already carries a resolved name: the feed is written for a different purpose, carries no health,
and correlating two events that happen to arrive on the same tick is the kind of coupling that
survives right up until something reorders them. The name comes through `Killfeed.nameOf`, which
is the same directory the feed lines are written from — a panel resolving names through a second
source could name a different killer than the line in the corner, which is the defect this round
has spent five sessions on.

### Measured

Every number came out of a run in this session.

**`auditHeaderSlots` — `shared/debug/HeaderSlotAudit`**, at the top of every harness run. P12
asks for *"the header model is a pure function of mode state, tested per mode without a DOM"*,
which is the whole reason the model is four plain fields and not a component:

| mode | cells | zones | labels |
|---|---|---|---|
| TDM | 0 | 0 | (none) |
| **DOM** | **3** | 3 | **A B C** |
| KC | 0 | 0 | (none) |
| FFA | 0 | 0 | (none) |
| **SND** | **2** | 2 | **A B** |
| RANGE | 0 | 0 | (none) |

**The red control failed, and finding that out is the most useful thing in this session.** With
Domination's `headerSlots` blanked — the exact bug — the audit came back **green**. The rule was
*"a cell per zone, or no cells at all"*, so Domination fell into the "no cells" arm; Search &
Destroy still filled its two; and the vacuity guard only fires when *every* mode is empty. An
assertion that passes on the bug it was written for is worth less than no assertion, because it
is also a claim that somebody checked.

The rule is now the one sentence F8 is actually about — **a mode that has objectives draws
them**, exactly — and modes with no zones satisfy it by arithmetic rather than by an exemption.
Re-run against the same blanked Domination:

    DOM: 0 header slot(s) against 3 objective zone(s). A mode draws one cell per objective
    HEADER SLOT AUDIT FAILED: 1 problem(s).        exit 1

**The rest of the gate.** `npm run check` green including the cosmetics audit. `npm run harness`
five matches, all completed, with every earlier audit still green beside the new one. `npm run
skirmish` **FLOW CHECK PASSED**, three clients, divergence 0/7373 each. `npm run leak` 100
cycles, subscriptions 29 → 29 (+0), heap 13.16 → 13.87 MiB (+0.71). `npm run layout` 11 surfaces
at 6 viewports, PASS. `npm run netharness` against a real `serve.js` reporting **protocol v15**,
2 clients, 30 s, **0 snapshots lost**, worst misprediction p99 0.25.

### What was not verified

- **Neither surface was rendered.** The header model is asserted per mode and the death sentence
  is a pure function with printed output, but that a cell fills as a flag is taken, or that the
  detail line is legible under the countdown, are claims about a browser.
- **`headerSlots` was only ever read at rest.** The audit constructs each mode and asks — which
  is why one of its assertions is that nothing is owned or filling on a match nobody has played.
  A flag actually *changing hands* is driven by `ObjectiveZone.step` and by replication, and no
  headless run in this session watched a cell go from neutral to held.
- **The S&D fuse fill was not run at all.** It is derived from `bombTimer` against
  `config.bombTimerSeconds` and no test in this session plants a bomb, so the arithmetic is
  reasoned rather than measured. It is the row most likely to be wrong.
- **`killerHealth` was not observed end to end over a socket.** The byte is written, decoded and
  replayed, and `netharness` proves the protocol still handshakes and loses nothing — but no
  assertion in this session reads a non-zero killer health out of the far end of a real
  connection. That is a headless probe somebody could write and I did not.

### Verified by eye, in a real browser

The browser pass on this session was reported complete. The specific observations were not
itemised back, so what is confirmed is that the checks below were run and nothing was raised —
which covers the header strip and the death panel as shipped. The S&D fuse fill and the
half-time recolour were the two rows this section flagged as most likely to be wrong, and
neither was reported as failing.

### Needs a browser

- **A Search & Destroy round with a plant.** Two cells, both neutral, until the bomb goes down —
  then the planted one takes the attackers' colour and drains for 45 seconds.
- **Three deaths in multiplayer.** The detail line should name the right killer and weapon, and
  the metres should be plausible for the fight you just lost. Die to a grenade and to a
  killstreak as well: neither should print a health figure, and neither should print a blank one.
- **A side swap in Search & Destroy at half-time.** The header must recolour, because the cells
  are relative to a viewer whose team just changed. This is the case the signature guard was
  written for and the one most likely to be wrong.

### Found while here

- **`Killfeed` had no way to ask who an entity is.** It resolved names internally and exposed
  nothing, so the second surface that needed a name would have reached for a second source. It
  has `nameOf` now — one line, and it is the difference between two surfaces agreeing by
  construction and agreeing by luck.
- **The `HeaderSlot` model has no room for a count**, and Search & Destroy's round number
  therefore is not in it. F8's brief mentions *"two sites and a round count"*; the round is
  already in the score banner and putting it in a strip of ownership cells would have meant a
  fifth field every other slot ignores. Recorded rather than done, because the moment a second
  mode wants a number in the header the shape should change once for both.
- **Nothing replicates a killstreak's owner health**, which is why `killerHealth` is 0 for a
  sentry rather than the owner's. That is the right answer for the panel — the sentry's health is
  not the lesson — but it means the field genuinely means "the person who killed you", and a
  future reader wanting "whatever killed you" would need a different one.

## Playtest round 5 — the first thirty seconds

**F13** was the game reporting its own broken promise: `[join] no background build ready for
mp_testbed; building it now (expect a hitch)`. **F6** was the room every player lands in being
nearly black. **F7** was the first objective they stand in drawing a flat opaque disc.

They are one session because they are one stretch: what a player sees between clicking `PLAY
MULTIPLAYER` and being in a real match. P11 asked for that sequence to be written down, because
nobody had.

### What actually happens between the click and the first frame of the arena

1. **The click.** `Game.playMultiplayer` resolves `multiplayerJoinOptions` — address from
   `?server` or `VITE_SERVER_URL`, name from the URL or the profile (round 5, B9) — and calls
   `launchMatch`.
2. **The handshake.** `handshake()` opens the socket and sends `Hello` with the protocol
   version, the name and the class. The server refuses a version mismatch before decoding a
   gameplay byte, then seats the player in the **arena** and replies `Welcome` naming
   `mp_testbed`.
3. **The cold build.** No prebuild exists on a first connect and none should: nothing was known
   to build before the socket said where you are going. `MatchWorld` builds `mp_testbed`
   synchronously behind the loading screen. **This is the one legitimate wait in the sequence.**
4. **The arena.** `WarmupMatch` has been `RUNNING` since server boot, so there is nothing to
   start — the player is in a live FFA against three bots with no score, no clock and no
   ladder (round 4, F7). *This is where F6 lives: the first thing anybody sees.*
5. **The ballot.** After 40 s the vote cycle opens mode, then map, 10 s each.
6. **Allocation, and the outbound prebuild.** `Server.allocate` creates a `LiveMatch` and sends
   every seat a `Prepare` naming the chosen map. The client starts building **while still
   shooting in the arena** — §6.5's whole mechanism — and reports `Ready` when it lands.
   `READY_WAIT` holds the match until everybody has or has timed out.
7. **Migration in.** `Migration.move` swaps the seat; the client adopts the map the queue
   already holds. No loading screen. *This transition has always worked.*
8. **The match.** *F7 lives here: the first flag anybody stands in.*
9. **The summary.** `finishLive` sends the board and holds it for `summaryHoldSeconds`.
   **This is where F13 was: nothing was prepared for the trip home.**
10. **Migration back.** Everybody returns to the arena, and `applyRotation` tore the world down
    and rebuilt `mp_testbed` synchronously, mid-transition, every cycle.
11. **Back to step 5.**

### F13 was a missing case, exactly as the brief guessed

`buildQueue.start` has one caller — `skirmishSink.onPrepare` — and `Prepare` was only ever sent
when a match was **allocated**. The arena is permanent, so nobody allocates it, so nobody
prepared it. Not a race; a case.

The fix is the same mechanism applied to the path that never had it: `finishLive` sends a
`Prepare` for the arena alongside the summary, so the return trip is built during a hold that
was already dead time. The window is `summaryHoldSeconds`; the build measures ~50 ms.

**One constraint found by reading rather than by breaking the gate.** `onComplete` answers a
`Prepare` with `sendReady(matchId)`, and `Router.mayAddress` counts a message addressed to an
instance you are not seated in as **misrouted** — which the skirmish gate asserts is zero. The
arena has no `READY_WAIT` to satisfy anyway (it is `RUNNING` from boot), so both the browser and
`HeadlessClient` now suppress the report for it. One condition each, not a second code path.

### The assertion was the deliverable, and the first version of it was worthless

P11 says the real deliverable of F13 is the assertion, not the fix. `HeadlessClient` had been
counting the exact number all along — `lateBuilds`, migrations that arrived with no map built —
behind an accessor **with no readers** whose comment read *"Arena returns are expected here."* A
number that measures §6.5's promise, computed every run, documented as permitted to fail, and
never looked at.

It is in the gate now. And the red control is what made it worth having:

| Run | Result |
|---|---|
| Bug (no arena `Prepare`), **default** skirmish | `0 late` · **FLOW CHECK PASSED** |
| Bug, `MATCH_ROUND_SECONDS=90` | **`6 migration(s) arrived with no map built — OP1 x2, OP2 x2, OP3 x2`** · FLOW CHECK FAILED |
| Fixed, `MATCH_ROUND_SECONDS=90` | `0 late` on every client, `4 build(s)` each where there were 2 · **FLOW CHECK PASSED** |

The first row is the trap. A default run never ends a match, so migrations go arena→live and
stop; the one transition F13 is about is not in the sample at all, and the assertion passes on
the bug. That is the second time this round — P12's header rule did the same — so the harness
now **says so**, in the shape it already used for the post-match hold:

    background build: the return to the arena was NOT EXERCISED — no match ended in this run,
    so the transition F13 is about never happened and the late-build count below proves
    nothing. Shorten MATCH_ROUND_SECONDS to reach it.

A green that cannot distinguish itself from an untested one is not a green.

### F6 — same floor, different lights, and now a number

The arena's floor is the `floor` material at albedo 0.1014 — **identical to Foundry's** — so the
whole difference was the lighting. `npm run readability` had been reporting per-map ground
brightness since round 4 and the arena was not in the table, which is the finding: every map in
it is one somebody chooses, and the one nobody chooses and everybody sees first was unmeasured.

| map | before | after |
|---|---|---|
| TESTBED | **51.0, flat** | **62.0, flat** |
| FOUNDRY | 61.7 (61 – 96) | unchanged |
| DUNES | 185.0 | unchanged |
| DEPOT | 21.3 | unchanged |

The target is **a comparison against another shipped map, not a number somebody liked**: the
arena has no business being darker than the average of the indoor map people already read fine.
Depot is deliberately a night map and is not the reference. The hemisphere does the work rather
than the sun — a lobby wants even light with no dark corner to be surprised by, and raising the
directional would have deepened shadows this room has no reason to have. Asserted by the probe,
which exits non-zero if the arena ever falls back under Foundry.

### F7 — the ring was fine, the fill was the disc

The thin annulus reads well and is untouched. The offender is the *progress* ring —
`RingGeometry(0.35, r-0.25)`, effectively a disc — at a flat **0.85**, near enough opaque that
it painted over the floor markings and anybody standing on it.

It pulses between **0.28 and 0.60** now, and the pulse rate is `stackRate` — *the same function
`ObjectiveZone.step` divides by `captureSeconds` to advance the capture*. So the disc reports
rather than decorates: one attacker gives a slow beat, a second speeds it up by 60%, a third by
a little less. From across the map "somebody is on B" and "three of them are on B" are now
different pictures, without a number to read. Head count comes from the replicated
`countA`/`countB`, so it is the server's answer on a networked client and never a second opinion.

`CAPTURE_STACK_FALLOFF` is a second copy of `DEFAULT_ZONE_CONFIG.stackFalloff`, and that is
deliberate rather than an oversight: importing a mode's tuning into the renderer is what
`check-cosmetics` exists to prevent, and the cost of the duplication is a decorative beat being
slightly off on the day somebody retunes stacking — a wrong *animation rate*, not a wrong
capture. Recorded below.

### Measured

Every number came out of a run in this session.

**`npm run skirmish`** — the three rows above. **`npm run readability`** — the brightness table
above, with the new `F6: the arena against its reference` assertion reading
`TESTBED 62.0 vs FOUNDRY 61.7 ok`.

**The rest of the gate.** `npm run check` green including the cosmetics audit — nothing here
touches a simulated value; the lights are map content read only by the renderer and the fill is
client-side. `npm run harness` five matches, all completed. `npm run layout` 11 surfaces at 6
viewports, PASS. `npm run leak` 100 cycles, subscriptions 29 → 29 (+0), heap 13.18 → 13.88 MiB
(+0.70), LEAK CHECK PASSED. No protocol change.

### What was not verified

- **The hitch itself was never observed, before or after.** `lateBuilds` counts migrations that
  had to build on arrival; it does not measure the frame time of doing so. The claim is that the
  build has moved off the transition, not how long the transition used to stall — that number
  does not exist and this session did not create it.
- **The cold path is unchanged and unmeasured.** Clicking `PLAY MULTIPLAYER` from nothing still
  builds `mp_testbed` behind a loading screen, and should. Whether *that* wait is acceptable is
  a separate question nobody has asked with a stopwatch.
- **Neither cosmetic change was rendered.** The arena's 62/255 is `MapLuminance`'s upper bound
  with no shadowing, AO or fog — so the real room is no brighter than this and may be darker in
  corners, which is the direction that keeps the claim safe but means "you can see the dummies"
  is still a browser claim. The capture pulse was not run at all.
- **`worstBuildMs` rose from ~48 ms to ~55 ms**, which is the arena builds joining the sample
  rather than anything getting slower. Two more builds per cycle per client, both inside a hold
  with nothing else happening.

### Needs a browser

- **Click `PLAY MULTIPLAYER` cold.** A loading screen, then the arena. Note whether the room
  reads immediately — geometry, dummies, other players — which is F6's actual bar.
- **Then sit through a full cycle: vote, match, summary, back to the arena.** The return is the
  one F13 is about. No hitch, and **no `[join] no background build ready` line in the console** —
  that line is now the symptom of a regression rather than of normal operation.
- **Stand in a capture point on Dunes.** The floor markings should be visible *through* the
  fill. Then have a second player join you on it: the pulse should visibly quicken, which is the
  half of F7 that is information rather than colour.
- **Watch a flag being taken off you from across the map.** The fill is in the attacker's colour
  and its beat is how many of them are on it.

### Found while here

- **`lateBuildCount` had no readers and a comment excusing the defect.** Fifth in this round
  after B7's score comparison, B9's rewind feed and its per-player XP lines, and P9's decal cap.
  The detector every time was asking who reads the thing — and this one is the sharpest case,
  because the number was not merely unread, it was *documented as allowed to be wrong*.
- **A default `npm run skirmish` exercises neither the summary nor the return.** Three
  assertions now say `NOT EXERCISED` in that run — the post-match hold, the reconnect, and as of
  this session the background build. That is three of the flow's most interesting transitions
  outside the default gate, and the fix is one environment variable. Worth asking whether the
  default should shorten the round itself.
- **`Game.applyRotation` builds synchronously when the queue misses**, logs a warning, and
  carries on — which is correct, and is why F13 was a hitch rather than a crash. It is also why
  it survived a milestone: the fallback works, so nothing failed, so nothing was reported until
  a human sat through it.


## Playtest round 5 — level 1, and a screen with nothing to offer at it

**F10** was *"open two or three primaries at level 1"*: one weapon available, ten gated from 4 to
38, and all five classes therefore showing `M4 CARBINE`. It is the only item this round that is a
decision rather than a defect, and P13 asked for the decision to be made out loud rather than
implemented from the brief's suggestion.

### The five classes were identical because nothing else was legal, and the file said so

The mechanism is one sentence and it was already written down, in `Loadouts.ts`'s own doc
comment: **at level 1 the arsenal was the carbine and the sidearm, so five slots had nothing to
differ on.** Everything else a class holds is gated too — FRAG and FLASHBANG are the only
equipment under level 3, MUNITIONS the only field upgrade under 6, and tier 2 is empty until 5 —
which leaves LIGHTWEIGHT and QUICKDRAW as the entire space of level-1 choice. Four combinations
for five slots, and the shipped table used one of them twice.

That is also why the presets could not have been fixed on their own. `sanitiseLoadout` runs after
`normaliseSave` on every load and after every edit; a default naming a locked weapon is reverted
to `ar_carbine` and the reversion is *reported*, so a table that showed a sniper at level 1 would
have arrived on screen as the carbine anyway. **The presets are downstream of the arsenal, and
the arsenal is the fix.** The probe below asserts that relationship rather than trusting it: it
runs `sanitiseLoadout` over all five defaults on a fresh profile and fails if it changes a field.

### The decision: three weapons that lose different fights

The brief suggested the AR that already exists, an SMG and the shotgun, *"to argue with rather
than implement"*. It is taken, and the argument is `docs/BALANCE.md`'s band table rather than the
archetype names:

| Level 1 | Its band | What it gives up |
|---|---|---|
| M4 CARBINE | 3-shot flat to 25 m, 0.167 s | never the fastest anywhere |
| WASP 9 | 0-7 m at 0.117 s, the fastest kill in the game | seven rounds and 0.350 s past 18 m |
| BREACHER 12 | one shell inside 6 m | nothing at all past 13 m, at 90 RPM |

Three rows, three ways of losing. A level-1 arsenal of the carbine and the VULCAN would be two
entries in one row, which is a second weapon and not a second choice.

**What was refused is the other half of the principle.** Neither sniper and neither LMG opens at
level 1, and not because they are strong: because each costs a *mechanic* nobody has been taught
in their first hour — 0.35-0.44 s of scope-in with sway and a glint, and a 0.42 s ADS behind a
four-second reload. The report's own framing is that a new player's first match is already a loss
against a VETERAN paying zero XP; handing them the weapon that plays as "I never hit anything" is
not generosity. The KESTREL is instead the ladder's first *archetype* rung, which is a better use
of the best unlock in the game than giving it away.

### A level is not a unit of play down here, and that is the whole re-spacing problem

The brief said the curve in `Levels.ts` is the other half of the conversation. It is, and the
measurement is the reason:

- One match of the shipped `AVERAGE_MATCH` is worth **3,870 XP** (`xpPerMatch`, from `XP_SOURCES`).
- `xpAtLevelStart(5)` is **3,300**. Levels 2, 3, 4 and 5 are therefore all crossed on the **first
  summary screen a player ever sees**.

So a gate at level 2 and a gate at level 5 are the same gate to anybody playing, and "re-spaced
the ladder from 4, 6, 9, 12 to 2, 5, 7, 9" would have been arithmetic nobody experiences. The
rungs are placed in **matches**, and `npm run progression` asserts them in matches: it converts
each `unlockLevel` into the match an average player first reaches it in and fails if two
consecutive rungs share one.

Because `AVERAGE_MATCH` describes a competent player — 18 kills, a third of them headshots — it is
the optimistic end of the range and therefore the *strict* end for that assertion. The probe also
prints a second column from a declared `NEWCOMER_MATCH` (6 kills, 1 headshot, 3 assists, no
longshots, 35% wins, no MVP, 200 challenge XP, worth **2,025 XP**). It is labelled in the source as
a scenario and not a measurement: this round's reporter was a script that stood still for long
stretches, so the project has no measured new-player scoreline and this probe does not invent one.
The two columns bracket the answer instead of one of them pretending to be it.

### The ladder, before and after

| Weapon | Class | Level was → is | Match was → is | Newcomer was → is |
|---|---|---:|---:|---:|
| M4 CARBINE | AR | 1 → 1 | 0 → 0 | 0 → 0 |
| WASP 9 | SMG | 4 → **1** | 1 → 0 | 2 → 0 |
| BREACHER 12 | SHOTGUN | 9 → **1** | 4 → 0 | 6 → 0 |
| VULCAN 74 | AR | 6 → **2** | 2 → 1 | 3 → 1 |
| KESTREL .338 | SNIPER | 18 → **11** | 16 → 5 | 29 → 10 |
| BASTION 249 | LMG | 25 → **15** | 32 → 10 | 61 → 19 |
| MERIDIAN P40 | SMG | 15 → **18** | 10 → 16 | 19 → 29 |
| HALCYON B5 | AR | 12 → **21** | 6 → 22 | 12 → 42 |
| LONGBOW MK3 | AR | 20 → **25** | 20 → 32 | 37 → 61 |
| MONOLITH 60 | LMG | 32 → **31** | 55 → 52 | 105 → 98 |
| VANTAGE SR | SNIPER | 38 → 38 | 80 → 80 | 152 → 152 |

Two rules produced that column, and both are written into `Unlocks.ts` beside the gates they
explain rather than left as intent:

**Archetype before variant.** The KESTREL and the BASTION are the fourth and fifth *kinds* of
weapon, so they sit at 11 and 15 — ahead of the two remaining ARs at 21 and 25. All five
archetypes are owned inside the first ten matches; everything past that is a variant, which is
the right shape for a long tail and the wrong shape for a first hour.

**One exception, and it is not about the weapon.** The VULCAN at 2 breaks that ordering
deliberately. Levels 2 to 5 are that first summary screen, and level 2's flourish named nothing at
all — `unlocksAtLevel(2)` returned an empty list. The report's complaint is that three systems all
answer "not yet" at the same moment; a level-up caption with nothing in it is a fourth. The VULCAN
is the cheapest thing on the ladder to pay that moment with.

The tail is unchanged on purpose. The VANTAGE stays at 38 — 80 matches, thirteen hours at ten
minutes a match — because shortening the ladder was not what was asked for and the top of it is
the only thing left to want.

### The curve was looked at and deliberately not moved

`LEVEL_XP` is unchanged. Three reasons, in the order they mattered:

1. **Every other gated category is already authored against these numbers.** Twelve perks, five
   pieces of equipment and four field upgrades sit on this curve. Re-pricing the opening to make
   levels 2-5 distinct events would move all of them, and F10 is a weapons item.
2. **The burst is a reward, not an accident.** Four flourishes on the first summary screen is what
   a front-loaded curve is *for*, and the file says so. The defect was not that the burst exists;
   it was that nothing was in it.
3. **The unit problem is solved by measuring in matches**, which the probe now does permanently.
   That is a smaller change than re-pricing 54 rows and it is the one that stays true if the XP
   table moves later.

What did move is a **number in a comment that had stopped being true**. `LEVEL_XP` said the first
ten levels are *"about six matches"*; at 3,870 XP a match it is four to level 10 and five to level
11. Corrected against the run rather than re-estimated, and the paragraph above it now states how
front-loaded the opening actually is, because that is the fact anybody re-spacing against this
table needs first.

### The five classes, and what they are allowed to differ on

| Class | Primary | Perks | Streaks |
|---|---|---|---|
| ASSAULT | M4 CARBINE | LIGHTWEIGHT · QUICKDRAW | UAV · CARE PACKAGE · MORTAR |
| SCOUT | WASP 9 | LIGHTWEIGHT | UAV · COUNTER-UAV · CARE PACKAGE |
| BREACH | BREACHER 12 | LIGHTWEIGHT · QUICKDRAW | UAV · CARE PACKAGE · SENTRY |
| SUPPORT | M4 CARBINE | — | UAV · CARE PACKAGE · SENTRY |
| MARKSMAN | M4 CARBINE | QUICKDRAW | UAV · COUNTER-UAV · MORTAR |

**Two names still share the carbine, and the reason is the decision above rather than the old
constraint.** SUPPORT wants an LMG and MARKSMAN wants a sniper; those are precisely the two
archetypes the ladder holds back, and the carbine is the only level-1 primary that holds a fight
past 15 m. Both become themselves when the ladder pays — the KESTREL at 11, the BASTION at 15 —
and meanwhile they are separated by the two axes a level-1 profile actually has.

The second of those axes is new here and worth naming: **streaks are gated by kills, not by
level**, so all six are legal on a fresh profile and they are the widest choice the screen offers
at level 1. The rule the trios keep is the one that was already in the file — a fresh profile
should be able to earn everything it has equipped — so nothing above the SENTRY's eight kills
appears and the CHOPPER GUNNER's twelve is in none of them.

Two smaller things fell out of rewriting the table. `makeSlot` took `lethal`, `tactical` and
`fieldUpgrade` as parameters and was handed the same three values five times: at level 1 there is
exactly one legal argument for each, and **a parameter with one legal argument lies about what
varies**. They are constants in the builder now, with the levels that would make them parameters
again named in the comment. And `DEFAULT_STREAKS` is gone, because the trio is a per-class
decision now rather than a default.

### The probe, and it was red on the tree it was written against

`npm run progression` gained a second half. The pattern this file keeps recording is a probe that
reads the table it is checking and is therefore green on the bug, so the level-1 arsenal is
**written out in the probe as a decision** — `LEVEL_ONE_PRIMARIES` — and compared against what the
defs actually gate. Changing the arsenal means arguing with that list.

Run against the tree as it was, before a def was touched:

| # | What it said |
|---|---|
| 1 | `WASP 9 is meant to be available at level 1 and is gated at 4.` |
| 2 | `BREACHER 12 is meant to be available at level 1 and is gated at 9.` |
| 3 | `classes ASSAULT and MARKSMAN are identical in every field a player can see.` |
| 4 | `WASP 9 is available at level 1 and no default class carries it.` |
| 5 | `BREACHER 12 is available at level 1 and no default class carries it.` |

Row 3 is the one nobody reported. F10 said the five classes all *show* the same weapon; ASSAULT
and MARKSMAN were byte-identical in every field — same weapon, same perks, same equipment, same
field upgrade, same streaks. Two of the five slots were not similar, they were the same class
twice, and no browser was needed to see it.

Seven assertions, and each is a way for this to be wrong again:

1. Every weapon in `LEVEL_ONE_PRIMARIES` is a primary and is unlocked on a fresh save.
2. No other primary is. A ladder with nothing left on it is the other way to fail F10.
3. The level-1 arsenal spans at least three weapon classes — three of one class is one feel.
4. No two consecutive gated rungs land in the same match at the optimistic rate.
5. No two default classes are identical in any field a player can see.
6. `sanitiseLoadout` changes nothing in any default class on a fresh profile.
7. Every level-1 primary is carried by at least one default class. An unlock the screen never
   shows is one nobody finds.

### `XpSimulator` moved to `shared/`

It lived in `client/debug/` beside the F1 panel that draws it, and it has never touched the DOM:
every line is arithmetic over `XP_SOURCES`, `LEVEL_XP` and the unlock tables. Assertion 4 needs
to know what a match is worth, and a second copy of `xpPerMatch` in `server/` would have been
exactly the two-sources mistake the file's own header warns about. It is `shared/meta/XpSimulator.ts`
now, with two import lines updated and nothing else changed — the same argument `stepLevelBar`
makes one file away: the half that can be wrong invisibly belongs where it can be measured.

### Measured

Every number came out of a run in this session.

**`npm run progression`** — both halves. The round-4 bar cases 0 failures with the red control
still not terminating (>36,000 steps, 35,934 crossings), and the new ladder half 5 failures before
the change and **0 after**. `AVERAGE_MATCH` 3,870 XP, `NEWCOMER_MATCH` 2,025 XP, and the
before/after ladder table above.

**`npm run check`** green — 311 files across the partition, and the unlock audit reads *"12
weapons, 12 perks, 4 field upgrades, 5 equipment, 6 camos, every one with an unlock record, and
all 6 requirement accessors reach the picker."* No `unlockLevel` was added or removed; ten changed
value.

**`npm run harness`** — 5 matches, 5 completed, 0 incomplete, `rowsOverHundred: 0`, heap 11.9 MiB.

**`npm run skirmish`** — FLOW CHECK PASSED. 3 clients, 3 migrations and 0 failed, 0 misrouted,
0 mispredictions in all three windows, 0 late builds, heap 28.2 MiB. It is a *control* here
rather than a test of this change: the skirmish clients carry a hardcoded `ar_carbine` loadout
and never read `defaultLoadouts`, so what it establishes is that nothing else moved. Its three
standing `NOT EXERCISED` lines — the post-match hold, the return build and the reconnect — are
the default-run limitation recorded in the P11 session above and are unrelated to this one.

**No protocol change, and no simulated value changed.** `unlockLevel` is read only by
`UnlockState`, and bot weapons come from `BOT_ARSENAL` by tier and have never consulted it — so
what the ten bots on a map carry is identical before and after.

### What was not verified

- **Nothing here is balance.** The three level-1 weapons were chosen against `docs/BALANCE.md`'s
  existing measurements; no time-to-kill was re-measured and none changed. Whether a first-time
  player *should* have a one-shot shotgun is a feel question and this round measured no feel.
- **The pacing numbers are projections, not observations.** "Five matches to the KESTREL" is
  `xpAtLevelStart(11) / xpPerMatch(AVERAGE_MATCH)` and nothing has played five matches to check
  it. The newcomer column is a declared scenario and is weaker still — it is an honest bracket,
  not a measurement.
- **An existing save between the old and new gates loses a weapon.** The HALCYON went 12 → 21, the
  LONGBOW 20 → 25 and the MERIDIAN 15 → 18, so a profile in those bands has its primary reverted
  to the carbine by `sanitiseLoadout` on next load. That is the designed behaviour for a locked
  item and it is reported rather than silent — but only to the console (see *Found while here*).
  No migration was written; on a game in playtest with no live population that was judged not to
  be worth a save-schema field.

### Needs a browser

- **Reset progress, then open `CREATE A CLASS`.** The class strip should read `M4 CARBINE`,
  `WASP 9`, `BREACHER 12`, `M4 CARBINE`, `M4 CARBINE` down the five rows — the strip's blurb is
  `requireWeapon(slot.primary.weaponId).name`, so this is the whole visible half of F10.
- **Open the primary picker on a fresh profile.** Three weapons with no chip, eight with
  `LEVEL n` — 2, 11, 15, 18, 21, 25, 31, 38. The chips come from `weaponRequirement`, so a wrong
  number there is a different bug from a wrong gate.
- **Look at the 3D preview and the stat table for all three.** The screen's argument is that the
  numbers come from `resolveLoadout` and the model from `buildWeaponModel`; three different
  weapons at level 1 is the first time a new player can see that argument work.
- **Play a match and press 1, 2 and 3.** The quick class selector now switches between three
  genuinely different weapons on a fresh profile, which it has never been able to do.
- **Finish a match from a fresh profile and watch the level-up flourishes.** Four of them, and the
  first should name `VULCAN 74`. That caption is `unlocksAtLevel(2)`, which returned an empty list
  before this session.

### Found while here

- **A reverted loadout is a `console.warn` and nothing else.** `Profile.loadReport` collects every
  line `sanitiseLoadout` produces and the only reader is `console.warn`. A player whose weapon was
  taken away by a re-spacing — or by a prestige, which is the same path — is told nothing on
  screen. Same cause as this session in the sense that raising a gate is what makes it fire, but a
  different fix (a surface, not a table), so it is recorded rather than done.
- **Seventeen levels at the top of the ladder unlock nothing at all.** Past the VANTAGE at 38 and
  COLD-BLOODED at 30, levels 39-55 award only XP. That is 369,000 XP — more than half the curve —
  against a prestige icon. Not a defect and not in F10's scope; it is the shape of the argument
  M12's content list will have to answer.
- **`unlocksAtLevel` is the only reader of the whole ladder as a ladder**, and it is a caption
  builder. There is no screen anywhere that shows a player what is coming — the picker shows a
  locked row's level one item at a time. A "next unlock" line on the summary screen would be cheap
  and is the natural companion to this session; it was not built because F10 did not ask for it.


## Playtest round 5 — the sky, and the seam that had to be impossible rather than fixed

**F2**: `scene.background` was `new THREE.Color(def.ambient.fogColor)` and nothing else, so
looking up on Dunes gave a uniform beige rectangle and flying above the map gave a village in a
void of the same beige. The brief called it the cheapest large improvement available, and it is
the one that costs nothing against the no-external-assets rule.

### The constraint decided the shape, and it is the reason there is no horizon colour

P8's constraint was that the horizon must be the map's `fogColor`, so geometry fades into fog,
fog meets the sky, and the seam is not drawable. The way to honour that is not to author it
twice and check the two agree. **`SkyDef` has no horizon field.** The shader takes the bottom of
its gradient from `def.ambient.fogColor` directly, so there is no second number that can drift
and nothing for a check to compare — the same shape as P13's sun direction, one paragraph down.

Two things follow that are worth stating because they are the difference between a sky that is
present and one that is right:

- **The dome is tone-mapped.** A fully-fogged world pixel is `fogColor` decoded to linear, ACES
  mapped at exposure 1.25 and encoded back to sRGB. A shader that wrote the authored hex
  straight out would be the same colour and a visibly different pixel, with the join drawn
  across the middle of the screen. So the fragment shader works in linear and ends with three's
  own `tonemapping_fragment` and `colorspace_fragment` chunks. The gunship shaders next door
  deliberately skip both — an optic is a false-colour readout — and copying them here would have
  produced exactly the seam the constraint exists to remove.
- **The horizon is not checked, because it cannot be wrong.** `npm run readability` has plenty
  to say about the sky and nothing to say about that.

### Where the sun is, and why the type has no field for it

*"Positioned from the map's existing directional light rather than from a new number, so the
light in the scene and the light in the sky cannot disagree."* Taken literally: `SkyDiscDef`
carries a colour, two angles and an intensity, and **no direction**. `SkyDome` walks
`def.lights` for the first directional and puts the disc at the negation of the direction the
light travels. A map with shadows pointing one way and a sun sitting the other is not a bug that
can be introduced here; it is a state with no representation.

A map with no directional light draws no disc rather than a default one. That case is a *rule*
in the probe — a disc asked for on a map with no key light, or a key light pointing upward that
would put the sun under the floor — because those are the two ways the omission can still be got
wrong from the authoring side.

### It never moves, and nothing updates it

The vertex shader drops the translation out of the model-view matrix and writes
`gl_Position = pos.xyww`, which puts every fragment at the far plane centred on the camera. So:

- the dome is at infinity **by construction** rather than by being large, and the sphere's radius
  is irrelevant — it is 1;
- there is no per-frame `position.copy(camera.position)` beside `particulate.update` to forget;
- and the free camera cannot fly out of it, which is the check the brief asks for.

`Particulate` does the opposite and is right to: dust is *near*, and its parallax is the whole
effect. A horizon's correct parallax is none, and that decides the silhouettes too — see below.

### The silhouettes are drawn at infinity, not placed past the walls

The brief asked for "distant silhouette bands past the boundary … flat, unlit, fogged, a few
triangles". They are in the sky instead of in the world, and the reason is arithmetic rather
than convenience: **a map is sixty metres across, so scenery near enough to show parallax is
near enough to fly to.** A band at 120 m would shift by twenty degrees as a player crossed
Dunes, which reads as large scenery rather than as distance, and the free camera would reach it
in four seconds and prove it was a wall — the exact failure the verification step is looking
for. Real hills at a kilometre shift by under two degrees across a whole map. No parallax is the
accurate answer here, not the cheap one.

What replaces the fog is the ridge's own vertical fade: its base washes out into the horizon
colour and its top stands clear of it, which is aerial perspective the right way round and is
what removes any line at the horizon.

**One generator, two extremes.** `shared/world/SkyProfile.ts` places `count` features around the
circle, hashes each one's height from the map's `seed`, and either interpolates between them —
a ridge — or holds each across its own width and turns over at the edge — a skyline of blocks.
`hardness` blends the two. Dunes is 7 features at `hardness: 0`; Depot is 22 at 1; Foundry is 13
at 0.72, because a steelworks is towers with ducting between them rather than a row of flat
roofs. There is no per-map `kind` to switch on and no second code path.

The profile is a **512×1 red-channel `DataTexture`**, sampled by azimuth. It is the only texture
this feature allocates.

### Per-map, and the two numbers that are not the same number

The brief: *"if the sky ends up with a constant in `MapRender.ts`, the sky is wrong for at least
three of the four maps."* Nothing is constant; `SkyDef` is a required field on `AmbientDef`, so a
map added later cannot forget it — the compiler asks.

The zenith is authored rather than derived, and `ambient.skyColor` is why. That field already
existed and is the **hemisphere light's** upper term: a lighting number, chosen for what it does
to an upward-facing surface. Depot's is `0x6d7f9c`, which is a sensible bounce colour for a night
yard and a ridiculous night sky; used as one it would have put a bright grey lid over the darkest
map in the game. The two are now documented as the two different questions they answer.

| Map | Horizon (`fogColor`) | Zenith | Contrast | Sun/moon | Ridge |
|---|---|---|---:|---|---|
| DUNES | `0xc9ae83` | `0x5f8fc4` | 1.59x | 2.2° warm disc at 70° | 7 dunes, smooth, 19° |
| DEPOT | `0x2c3444` | `0x0d1424` | 1.47x | 1.1° pale moon at 62° | 22 blocks, hard, 13° |
| FOUNDRY | `0x272b33` | `0x0f1730` | 1.25x | 1.8° warm disc at 55° | 13 towers, 0.72, 15° |
| TESTBED | `0x1b2028` | `0x2c3d5c` | 1.50x | 1.6° disc at 53° | **none** |

Two of those rows are decisions rather than settings. **Foundry's is the shallowest gradient of
the four and its own fog is why**: the horizon is pinned to a dark cold `0x272b33`, so the only
direction a zenith can go and still be a gradient is down. And **the testbed has no ridge on
purpose.** It gets the gradient and the disc — it is the room everybody lands in, so F2's flat
lid is more visible there than anywhere, which is the same argument round 5's F6 made about its
lights. It does not get a horizon, because a ridge line is a claim that there is a place out
there and this is a grey-box measurement room with a speed lane down one side.

### The layer, and the pass it exists for

`renderGunship` draws the scene three times with `scene.overrideMaterial` set. An inward-facing
dome pinned to the far plane, drawn as thermal terrain, is a grey wall over the entire optic. The
fix is not a fourth visibility toggle in that pass: the dome sits on `SKY_LAYER` and **only
`CameraRig`'s camera enables it.** A camera's default mask is layer 0 alone, and three tests
`object.layers` against `light.layers` for shadow casters exactly as it tests the camera's for
the main pass — so the thermal camera, every shadow camera and any camera a later milestone adds
see no sky until they ask. The default is the mechanism.

`SKY_LAYER` is declared in `engine/Renderer.ts` rather than beside the dome, because that is
where the reason lives and because `engine/` may not import `world/`.

### The probe, and a rule with no number in it

`npm run readability` gained a sky section. Four things are checked, and the interesting part is
which of them is a rule and which is a reading — this file's exit-code note says a reading with
no agreed threshold must not fail a build, and that still holds.

**Rules, each with no legitimate exception:** a zenith equal to the fog colour (F2 again, with
more code behind it); a disc asked for on a map with no directional light; a key light pointing
upward, which puts the sun under the floor; a ridge brighter than the haze it stands in, which is
not what the word silhouette means; and the seam.

**Readings, printed and not asserted:** the horizon-to-zenith contrast ratio, the largest
per-channel step — WCAG contrast is hue-blind by construction and Foundry's gradient does most of
its work in hue — and the ridge's peak, floor and step sizes.

The seam rule is the one worth writing down, because **the obvious version of it does not work.**
The first attempt compared the step at the wrap against the worst ordinary step. That catches a
crack in Dunes' smooth ridge and cannot catch one in Depot's, where a step the size of a building
is the point and a seam hides among twenty-two of them. What the horizon actually owes is that it
be a *function of the direction you are facing* — so the rule is that `skylineAt(def, i)` and
`skylineAt(def, i + samples)` are the same number, one full turn on. That is exact, it needs no
threshold, and a generator that indexes its control points without the modulo fails it for every
map and every hardness.

Watched red, because a probe nobody has seen fail has not been written:

| Red control | What it reported |
|---|---|
| the sky as F2 found it — `0xc9ae83` in both directions | contrast **1.00x**, which the table calls FLAT |
| the same three ridges from a generator with no wrap | periodicity **9.315° / 8.614° / 8.151°**, which the table calls SEAM |

Against **0.000°** on all three shipped ridges.

### Measured

Every number came out of a run in this session.

**`npm run readability`** — the two tables above, sky failures 0, and both red controls firing.

**`npm run check`** green — 313 files across the partition (up 2: `SkyDome.ts` and
`SkyProfile.ts`), and **the cosmetic audit unchanged at 19 snapshot fields**. Nothing here
touches a simulated value: `SkyDef` is map content read by the renderer and by this probe, and no
snapshot, wire message or collision number moved.

**`npm run harness`** — 5 matches, 5 completed, 0 incomplete, and the interesting part is that
the five scorelines are **identical to the P13 run earlier in this session** (75-66, 75-66,
62-75, 44-75, 75-63 on the same seeds). The harness is seeded, so an unchanged scoreline is a
stronger statement than a green one: adding a required field to `AmbientDef` did not perturb a
single tick of simulation.

**`npm run skirmish`** — FLOW CHECK PASSED, as a control on the shared change.

**The bundle, before and after, from `vite build` on this tree**: 1,384.62 kB raw / 395.80 kB
gzip at HEAD, **1,390.33 kB / 398.07 kB** with the sky — **+5.71 kB raw, +2.27 kB gzip**, which
is the shader source, the profile generator and four `SkyDef` blocks. Still three network
requests and no asset of any kind.

**What it adds to a frame, counted rather than estimated**: **one draw call and 720 triangles**,
reported through `MapStats` like every other mesh, plus one 512-byte texture. The dome is
`SphereGeometry(1, 24, 16)` and the gradient is per fragment, so the tessellation only has to be
round.

### What was not verified

- **No frame numbers.** The brief asks for `__operator.frameReport()` before and after on Depot
  and Dunes, 600 samples each. That is a browser claim and this session cannot make it: the
  preview pane never fires `requestAnimationFrame`, so a frame report taken through it would be
  a number about a throttled clock. The draw-call and triangle counts above are the part that
  *can* be established headlessly, and they are the part the cost argument rests on — one
  additional draw call of 720 triangles with no lighting, no fog and no depth write, over a full
  screen of fragments. **The fill is the cost, and fill is what the frame report would measure.**
  It is first on the browser list.
- **The shader has never been compiled.** `tsc` sees a template literal and `vite build` bundles
  it as a string; GLSL is compiled by the driver on the first frame the dome is drawn. A typo in
  it is a black screen and a console error, not a build failure. Reviewed by hand for the two
  cases that bite — `pow(0.0, x)` is floored away from zero, and the disc's `smoothstep` edges
  are ordered — but reviewed is not run.
- **Nothing about how it looks.** Whether Dunes' zenith is the right blue, whether a 19° dune
  ridge reads as distance or as a wall, and whether Foundry's 1.25x gradient is visible at all on
  a real panel are all judgements about a picture. The probe says the numbers are not equal; it
  does not say anybody can see it.

### Needs a browser

- **`__operator.frameReport()`, 600 samples, on Depot and on Dunes.** Depot has the most
  geometry and Dunes the most open sky, which are the two different ways this could cost
  something. The round-5 baseline to beat is p50 16.7 ms, p95 16.8, p99 17.0.
- **Look up on all four maps.** A gradient with no banding, and the sun or moon where the
  shadows say it should be — stand beside a container on Depot, follow its shadow back, and the
  moon should be at the end of it. That is the one check the type cannot make for itself.
- **`__operator.spectate.noclip(true)` and fly past the boundary on each of the three outdoor
  maps.** The horizon should stay put as you climb and the ridge should stay at the same
  apparent size however far out you go — that is what "at infinity" means, and it is what a band
  placed in the world would fail. Then look back at the map from outside: it should sit on a
  horizon rather than float in a void, which is the second half of the report.
- **Stand where the fog is thickest and find the join.** Dunes' fog runs to 210 m; look down a
  street at the far wall and then up past it. There should be no line.
- **Call in a Chopper Gunner.** The thermal optic must show the grey world and orange bodies with
  **no sky at all**. If a grey wall fills the optic, the layer is not doing its job and that is
  the one regression this change can cause somewhere it is not visible.
- **Turn motion blur on.** The dome renders into a render target on that path, and the
  colour-space handling differs between a target and the canvas; the horizon seam is the place
  it would show.

### Found while here

- **`ambient.skyColor` has been two things wearing one name since M4.** It is the hemisphere
  light's sky term and nothing has ever drawn it. Every map's value was chosen as a lighting
  number, which is why none of them was usable as a zenith and why F2 could not have been fixed
  by pointing the background at it. It is documented now rather than renamed: a rename touches
  four map files and `MapLuminance`, and the comment is what was actually missing.
- **Foundry's fog is colder and darker than its key light.** `0x272b33` against a `0xffe3c2`
  key at 2.35 intensity describes a bright warm sun over a cold grey haze, which is a
  combination no time of day produces. It is left alone — changing a map's fog is a change to
  how the whole map reads and is not what F2 asked for — but it is why that map's sky has the
  least room to move, and it is worth a look next time somebody is in `foundry.ts`.
- **There is no instrument in this project that can measure a frame.** Four probes and three
  harnesses, and the one number the brief for a rendering feature asks for is the one thing only
  a real browser can produce. That is not a gap this session should close, but it is the reason
  every cosmetic session ends with the same list.


## Playtest round 5 — bodies, and the identity that had to be broken in exactly one direction

**F4**: *"A torso box and a head. No arms, no legs, no walk cycle, no weapon in the hands."* The
largest visual item in the round, and the one where the report and the tree disagreed most.

### Two thirds of the report was already false, and the measurement says why it read as true

`HUMANOID_RIG` has carried `armL`, `armR`, `legL` and `legR` since M2, and `BotMesh` has drawn
all four since M3 — `buildZoneGeometry(['torso', 'arm', 'leg'])`, one merged mesh. The limbs
were there. Two things made them invisible, and both are numbers rather than opinions:

- **They could not move.** Four boxes welded into one static mesh with the torso. A limb that
  never moves is a bump on a silhouette.
- **The two legs are 4 cm apart.** `legL` and `legR` sit at ±0.11 and are 0.18 wide, so their
  inner faces are at ∓0.02. At 1080p and 90° that gap is **4.3 px at 5 m, 1.1 px at 20 m and
  0.43 px at 50 m.** Sub-pixel legs are no legs, and the report was reading a picture correctly
  while describing it wrongly.

This is the shape of mistake round 5's own preamble says to kill before fixing — the withdrawn
auto-reload item. Killing it changed the work: a session that had only added an animation would
have left a standing body reading as a pillar, and one that had only widened the stance would
have broken the rig for no gain. **What makes the legs read is that they move**, which the
probe now says in the same units: the soles are 0.976 m apart at full stride, which is 26 px at
20 m against the standing gap's 1.1.

The third claim was correct and had no caveat: nothing anywhere advanced a phase.

### The weapon was not missing. It was the third description of a rifle

`buildGearGeometry` held five hand-typed boxes — a body, a magazine and a stock — the same on
every bot regardless of what `drawBotWeapon` dealt them. That is worse than absent, and it is
the exact defect round 4's F15 removed once already: `WeaponIcons` was a second description of
what a weapon looks like, it drifted, and the fix was to project the killfeed's glyph from
`WeaponModelSpec` so there is one source. This was the third.

`buildHeldWeaponGeometry` is that source applied to the third place that needed it. Same specs,
same parts, `lens` and `reticle` skipped for the same reason `WeaponSilhouette` skips them, and
the scale baked in because a shared geometry has no root to scale.

**It is not `buildWeaponModel`.** The viewmodel is five draw calls and a fresh set of
geometries, and it is five because the magazine and the charging handle are separate groups so
a reload can move them — a thing nothing outside the first person can see. So a held weapon is
one merged geometry with one material, cached per weapon id on `BotRenderer`: **ten bots drawing
from an eleven-weapon arsenal build four or five geometries, not ten.** The material is the
viewmodel's own shared gunmetal; a held weapon allocates none of its own.

The plumbing was the easy half, exactly as the brief predicted. `RenderableActor` gained
`weaponId`, and **neither side needed anything new**: a remote player's comes from
`EntitySnapshot.weaponIndex`, on the wire since M10 and already in the cosmetic audit's
allowlist as §4.15 gameplay state; a local bot's is `weapons.definition.id`, derived rather than
stored for the same reason `weaponProfile` is — `applyWeaponDef` can change the gun under a
live bot.

### The identity is rewritten, not silently dropped

`BotMesh` has said since M3: *"The mesh IS the rig: the boxes drawn here are the boxes a round
is tested against, so what you can hit is what you can see."* The M12 planning section quotes it
and says **"F4 is a proposal to break that identity, and that is the whole of F4."** It was
right, so the sentence is rewritten rather than left standing, and the M12 bullet above has been
rewritten with it.

What it says now:

- **The head and the torso are still exactly the rig.** They are the two boxes that decide
  fights and nothing moves them by a millimetre.
- **The arms and the legs are not.** The legs swing about their hips and the arms are pitched
  0.55 rad forward onto the weapon, while `HitboxRig` keeps both boxes upright.

F4 states the rule — *"if the legs move and the hitbox does not, that is correct and must be
stated in `PLAN.md` so nobody later fixes it"* — and the reason it is correct is that a hitbox
following a cosmetic animation is a cosmetic deciding gameplay, which is the §4.15 line. The rig
takes a yaw and a stance scale and nothing else, deliberately, and that has not changed.

**Stating it as prose is weaker than stating it as a number, so it is a number.** `npm run
readability` prints how far each drawn limb gets from its box, in metres and in pixels at the
three distances the browser check names:

| Limb | Worst | at 5 m | at 20 m | at 50 m | |
|---|---:|---:|---:|---:|---|
| leg | 0.412 m | 45 px | 11 px | 4.5 px | `limbMult` 0.92-0.94, the cheapest hit in the game |
| arm | 0.257 m | 28 px | 7 px | 2.8 px | a pose, not an animation — it never moves |
| torso | **0.000 m** | 0 | 0 | 0 | exactly the rig, and it decides fights |
| head | **0.000 m** | 0 | 0 | 0 | exactly the rig |

The divergence is confined to the two zones `HitboxRig`'s own comment calls *"the silhouette
edges where a sloppy spray lands"*, and they carry the two lowest multipliers in the game. That
is not a coincidence, it is the reason the split falls where it does.

### The gait is distance, not time, and that is what keeps it inside the boundary

F4's constraint: *"The animation is a function of replicated state that already exists. If you
find yourself wanting to send a phase, stop."* The strongest form is not to read velocity off
the snapshot either. **The phase is the integral of the distance the body was drawn to move**,
which the renderer already has because it just computed it — so there is no phase on the wire,
none in a snapshot, and no interface between the simulation and the animation at all. A remote
player and a local bot walk the same way because they covered the same ground.

It also removes the failure a time-driven cycle has and that people notice: legs that keep
walking while the body is stopped against a wall.

`shared/ai/Gait.ts` holds it, next to `BotVisualState.ts`, which is the same category of thing —
cosmetic data both halves of the partition have to agree about. It is in `shared/` for the
reason `MapLuminance`, `HudSurfaces` and `SkyProfile` are: so a headless process can read it.

**Two things it cannot do, and both are geometry rather than tuning.**

`STRIDE_METRES` is anchored to **cadence**, which is what an eye reads and is near-constant
across running speeds at about three footfalls a second. At this game's `walkSpeed` of 4.6 m/s,
3.07 m per cycle gives exactly 3.00 footfalls a second, and 4.50 at `sprintSpeed` 6.9. Measured,
not asserted — the probe prints the table.

But a rigid leg on a hip has no knee, so its sole can only travel `2 · L · sin(swing)` = 0.976 m
while the body covers 3.07 m. **68% of the stride is foot slide, and no amount of tuning removes
it.** Choosing the stride the other way round — the one a knee-less leg can cover honestly —
would put the cadence at eleven footfalls a second at a walk, which is not a run, it is a blur.
The slide is the price of the readable option and the probe prints the receipt.

And the sole rises 0.156 m at the extremes of the swing, because a rigid leg sweeps an arc.
Nothing compensates, and that is a decision with two rejected alternatives: dropping the leg
away from the hip opens a hole at the pelvis, and dipping the whole body moves the head and
torso boxes — the two the table above keeps at zero. At 4.6 m/s a body is running and a runner's
feet do leave the ground, so the artefact points at the truth.

### What the probe asserts, and it has no numbers in it

Four rules, each exact, in the same discipline the sky table keeps:

| Rule | Why it is a rule and not a taste |
|---|---|
| a cycle later is the same pose | a gait that is not periodic pops once a stride |
| the right leg is the left one half a cycle on | one that is not antisymmetric is a hop |
| both soles are on the ground at mid-stride | one whose sole is not is a body on tiptoe |
| a body that is not moving has its legs down | the phase stops with the body, so without the amplitude term the legs freeze mid-stride |

Plus one the respawn path needs: a 500 m jump wraps into one cycle rather than looping 163 times.

Cadence, slide and divergence are **readings**, printed and not asserted. They are consequences
of a rigid leg with no knee, nobody has agreed a bound for them, and inventing one here is what
this file's own exit-code note bans.

The red control is the tree this session started from: the 4 cm gap, in pixels, next to the
0.976 m the stride opens up.

### The cost, and the instancing question answered rather than dodged

Three meshes per body became six: body, head, gear, two legs and a weapon. On a ten-bot roster
that is **30 draw calls to 60**.

What pays for it is that **the geometries are shared now and were not before**. `BotMesh`'s
constructor used to call `buildZoneGeometry` twice and `buildGearGeometry` once *per bot* — ten
bodies merging and uploading ten identical copies of the same boxes. Splitting the legs out
would have made it thirty. They are built once in `BotAssets` and referenced by every mesh:
**geometry uploads go from 30 to 4 for the whole roster**, plus one per distinct weapon.

Instancing was considered and refused, and the argument is written into `BotAssets` rather than
left as a shrug. One `InstancedMesh` per team would fold the legs into two draw calls, but every
limb's world matrix would then be composed on the CPU and re-uploaded each frame — and the scene
graph is already composing the death fall, the flinch lean, the stance scale and the gait
correctly, for free, in the right order. Trading that for draw calls nobody has shown to be the
bottleneck is the wrong trade until a frame report says otherwise. It is written down so the
next person has the argument rather than the guess.

### Measured

Every number came out of a run in this session.

**`npm run readability`** — the gait table above: 5 rules green, cadence 1.82 / 3.00 / 4.50
footfalls a second at crouch / walk / sprint, slide 68%, and the divergence and red-control
figures quoted above.

**`npm run check`** green — 314 files across the partition (up 2: `Gait.ts` and the two probe
sections), and **the cosmetic audit unchanged at 19 snapshot fields.** Nothing was added to the
wire and no simulated value moved.

**`npm run harness`** — 5 matches, 5 completed, and the five scorelines are **identical to the
P13 and P8 runs earlier in this session** (75-66, 75-66, 62-75, 44-75, 75-63 on the same seeds).
Third time in a row, and it is the point: `RenderableActor` gained a field and `Bot` gained a
getter, and a seeded simulation produced the same ticks.

**`npm run skirmish`** — FLOW CHECK PASSED. 3 clients, 3 migrations and 0 failed, 0 misrouted,
0 mispredictions in all three windows. A control on the shared change, like P8's.

**The bundle**: 1,393.55 kB raw / 398.97 kB gzip, against P8's 1,390.33 / 398.07 — **+3.22 kB
raw, +0.90 kB gzip** for the gait, the held-weapon builder and the body rework.

### What was not verified

- **`npm run leak` cannot see any of this, and it was run anyway.** The brief names it, so it
  ran: 100 cycles, subscriptions 29 → 29 (+0), heap 13.24 → 13.92 MiB (+0.68), LEAK CHECK
  PASSED. But `HeadlessClient` builds no `ClientMatch`, no `BotRenderer` and no `three` at all,
  so what those numbers prove is that the *server* still releases what it allocates. The
  claim that a body's meshes are released with it rests on reading instead: `BotMesh.dispose`
  now clears its group and disposes **nothing**, because every geometry on it belongs to
  `BotAssets` or to `BotRenderer`'s weapon cache and both are disposed with the renderer. That
  inversion is the one thing here a reviewer should check by eye — the old per-bot `disposables`
  list would have torn shared geometry out from under the other nine bodies on the map.
- **No frame numbers.** The brief asks for `frameReport()` with a full ten-bot roster before and
  after. Same limit as P8: the preview pane never fires `requestAnimationFrame`. The draw-call
  and upload arithmetic above is the part that can be established headlessly.
- **Nothing about how it looks.** Whether 0.55 rad reads as a rifleman rather than a sleepwalker,
  whether 68% slide is visible at 20 m, and whether the weapon sits in the hands rather than
  near them are all judgements about a picture. The probe says the arithmetic holds.
- **The bodies were never rendered.** As with P8's shader, this compiles and bundles without
  anything having drawn a frame.

### Needs a browser

- **`frameReport()`, 600 samples, with a full ten-bot roster, before and after.** Depot at night
  with ten bodies is the case: six draw calls each against three, and the shared geometry is
  meant to more than pay for it.
- **A bot walking across the frame at 5 m, 20 m and 50 m** — the brief's own check. At 5 m the
  legs should read as two legs; at 50 m the *silhouette* should tell you the weapon, which is
  the argument for putting the real one in their hands.
- **A bot strafing while shooting.** The phase is driven by ground covered, so a sideways body
  still walks — whether that reads as a sidestep or as a moonwalk is the thing a distance-driven
  cycle can get wrong and no probe can see.
- **A bot stopping.** The amplitude eases to zero over about a tenth of a second, so the legs
  should settle upright rather than freezing mid-stride. Then watch one **die and respawn**: the
  fall should still work, and the first frame after the respawn must not read as a sprint.
- **Two bots with different weapons, side by side at 30 m.** A BREACHER 12 and a KESTREL .338
  should be different shapes. If they are not, the held geometry is not carrying the spec.
- **A Chopper Gunner over a moving roster.** The bodies are drawn hot and cold by group, and the
  legs are new children of those groups — a leg that renders in the wrong group, or not at all,
  would show there and nowhere else.

### Found while here

- **`BotMesh` was building ten copies of the same three geometries.** Not F4, and not new — it
  has been true since M9 split the renderer out — but it is the reason the cost note in the
  brief was worth taking seriously, and it is why six draw calls per body is affordable at all.
- **`RemoteActor` already resolved a weapon id and nothing read it.** `weaponId` has been set
  from `weaponIndex` on every snapshot since M10, and until this session the only consumer was
  the killfeed's own lookup. A replicated fact with no reader is the shape this file keeps
  recording; this one was benign, and it is the reason F4's first item cost no wire change.
- **`Bot.grounded` exists and the gait does not use it.** A body mid-jump keeps whatever phase
  it had, because the phase only advances with horizontal distance and a jump is mostly
  vertical. Adding the flag to `RenderableActor` to special-case a jump would be widening a
  shared interface to reach a case nobody reported; it is written here instead so the next
  report about it lands on a known decision rather than an oversight.


---

