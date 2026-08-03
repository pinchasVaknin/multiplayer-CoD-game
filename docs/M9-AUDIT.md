# M9 §6.1 — The browser-dependency audit

> Produced before any file was moved. This is the measured scope of Milestone 9.
> Method: static sweep of `src/` (56,067 lines, 194 TypeScript files) for `three` imports,
> DOM/BOM globals, `performance.now()`, `AudioContext`/`CanvasTexture`, cross-boundary
> imports into `engine/`, `ui/`, `debug/`, and entities that own a `THREE.Object3D`.

## 0. Headline

The codebase is in far better shape for this split than §6.1 anticipates. Of the **135 files
in directories destined for `shared/`, 106 are already clean** — no Three.js, no DOM, no
browser globals, no import that crosses into `engine/`, `ui/` or `debug/`. **29 files carry a
real browser dependency.** The simulation was written against plain-number state from M1
(`PlayerSim`, `Combatant`, `Contact`, `RayHit` are all scalar structs), and `Math.random()` is
genuinely absent from gameplay.

The cost is concentrated in four places, not spread thin:

1. **Killstreaks** — all six receive a `THREE.Scene`, `Fx` and `CameraRig` through
   `StreakContext`. This is the single largest split.
2. **`Bot` owns a `BotMesh`** — the predicted "simulation state and render state are the same
   object" offender. It is the only one, and it is one-way.
3. **`Match.ts`** — the composition root mixes sim and presentation in one class, and
   `simulate()` itself makes six presentation calls.
4. **Cosmetic subsystems parked in sim directories** — meshes, audio and textures living under
   `weapons/`, `combat/`, `meta/`, `equipment/` and `world/`.

---

## 1. Three.js imports that are not math classes

40 files import `three`. **Not one of them is in the per-tick simulation path.** No shared-bound
file uses `Vector3`/`Quaternion`/`Matrix4` for gameplay maths — the sim carries `x, y, z` as
loose numbers throughout, so §3's "Three math classes only" allowance is not even needed by the
sim. It is needed only by code that is moving to `client/` anyway.

### 1a. Whole files that are client-only and simply move

| File | Three symbols used |
|---|---|
| `ai/BotMesh.ts` | `Group`, `Mesh`, geometries, materials, `mergeGeometries` |
| `weapons/WeaponMesh.ts` | geometries, materials, `CanvasTexture` |
| `weapons/WeaponMeshParts.ts` | geometry construction |
| `weapons/KnifeMesh.ts` | geometries, `mergeGeometries` |
| `weapons/ViewmodelAnim.ts`, `weapons/ViewmodelConfig.ts` | `Vector3` + `Object3D` typing |
| `player/Viewmodel.ts` | `Group`, `Object3D` |
| `world/MapMesher.ts` | `BufferGeometry`, `BufferAttribute` |
| `world/Particulate.ts` | `Points`, `PointsMaterial`, `BufferGeometry` |
| `meta/Camos.ts` | `CanvasTexture`, `Texture`, `RepeatWrapping`, `SRGBColorSpace` |
| `equipment/EquipmentFx.ts` | geometries, materials, `PointLight`, `CanvasTexture` |
| `perks/PerksRuntime.ts` | `Scene`, `Mesh`, `Points` — **see 1c, it is a hybrid** |

`three/examples/jsm/utils/BufferGeometryUtils.js` (`mergeGeometries`) is imported by four files:
`weapons/WeaponMesh.ts`, `weapons/KnifeMesh.ts`, `combat/TargetDummy.ts`, `ai/BotMesh.ts`. All
four are client-bound, so this dependency leaves `shared/` entirely.

### 1b. Files that split

| File | Shared half | Client half |
|---|---|---|
| `world/MapLoader.ts` | `ColliderSet` build from brushes + props, `CollisionWorld`, nav bounds, spawn zones (lines ~54–90) | `THREE.Group`, merged brush geometry, instanced props, materials, lights, fog, shadow tiers (lines ~92–272) |
| `streaks/SentryGun.ts` | targeting, tracking, firing through `DamageSystem` | `group`, `yawNode`, leg/body/barrel meshes |
| `streaks/CarePackage.ts` | drop physics, capture timer, contents roll | crate meshes, chute, `THREE.Raycaster` (debug-tier use, per §4.3) |
| `streaks/ChopperGunner.ts` | flight path, gun, damage | `PerspectiveCamera` takeover |
| `streaks/MortarStrike.ts`, `Uav.ts`, `CounterUav.ts` | **already clean** — logic only | (their visuals are elsewhere) |
| `combat/TargetDummy.ts` | hit accounting, DPS window | `CanvasTexture` read-out, `document.createElement('canvas')`, meshes |
| `combat/TargetRange.ts` | range logic | `Group`, `Camera` |
| `ai/BotDirector.ts` | roster, spawning, scheduling, navmesh bake | one `THREE.Group` per team, used purely as a scene parent |
| `meta/Camos.ts` | camo ids, unlock prerequisites, `CamoId` type | procedural texture generation |

### 1c. `perks/PerksRuntime.ts` — the one genuinely awkward file

It imports `Scene`, builds `Mesh` and `Points`, and also owns perk effect hooks that the server
must run. §3 puts `perks/` wholly in `shared/`. This file does not obey that; the visual half
has to be lifted out into `client/`.

---

## 2. `window`, `document`, `localStorage`, `requestAnimationFrame`

Small and precise. Every hit in shared-bound code is listed.

| Site | What it is | Disposition |
|---|---|---|
| `core/Input.ts` (26 sites) | `window.addEventListener` for key/mouse/wheel, pointer-lock, fullscreen | Whole file → `client/input/`. It already produces `InputCommand`, so nothing downstream changes. |
| `core/SaveStore.ts` (`window.setTimeout`, `window.localStorage`) | debounced save wrapper | Whole file → `client/`. §6.2 predicted this correctly. |
| `core/Loop.ts` (`requestAnimationFrame`, `cancelAnimationFrame`) | the browser frame driver | **Splits.** Accumulator/tick math → `shared/core/`; the rAF driver → `client/`; the drift-corrected driver → `server/Loop.ts` (§4.10). |
| `meta/SaveData.ts:188` (`window.localStorage.getItem`) | one line, a legacy-settings migration read | Move the read to `client/`; leave the schema and migration logic shared. |
| `combat/TargetDummy.ts:161`, `weapons/WeaponMesh.ts:378`, `meta/Camos.ts:131`, `equipment/EquipmentFx.ts:334` | `document.createElement('canvas')` for procedural textures | All client-bound already. |

**`localStorage` appears in exactly two files.** `meta/Profile.ts` reaches it only through
`SaveStore`, so the progression *rules* separate from persistence cleanly, as §6.2 expects.

---

## 3. `performance.now()`

**This is the audit's best news and it is worth stating plainly: `performance.now()` is used
nowhere for gameplay timing in shared-bound code. Every single occurrence is instrumentation.**

| Site | Purpose |
|---|---|
| `ai/AiScheduler.ts:107,140` | AI millisecond budget metric |
| `world/NavBake.ts:56,124` | navmesh bake duration stat |
| `world/MapLoader.ts:50,112,114,272` | map build / AO duration stats |
| `streaks/StreakSystem.ts:225,236` | streak system ms metric |
| `combat/DamageSystem.ts:252` | `report.atMs` — a debug damage-report timestamp |
| `Match.ts:863,865,871` | mode-step ms metric; `LatencyProbe` expiry |

Gameplay time is `tickIndex * DT` everywhere, exactly as §4.1 requires. So the "shared clock
abstraction with a browser and a Node implementation" (§3) is needed **for measurement only** —
it does not touch simulation correctness. That materially de-risks the milestone.

One contract note: `InputCommand.sampledAtMs` is documented as `performance.now()` at sample
time. The field is never read by the simulation — only by `LatencyProbe`. It stays, but its
docstring needs to name the clock abstraction rather than the browser API.

---

## 4. `AudioContext` and the audio graph

No shared-bound file constructs an `AudioContext`. Audio enters sim directories only as *typed
imports of the client's synthesiser*:

- `weapons/WeaponAudio.ts` → `engine/ProceduralAudio`
- `streaks/StreakAudio.ts` → `engine/ProceduralAudio`, `engine/AudioSpecs`
- `equipment/EquipmentAudio.ts` → `engine/ProceduralAudio`

All three are sound-design files that happen to live next to their systems. They move to
`client/engine/` wholesale. Their triggers are already `EventBus` events, per §6.2.

---

## 5. Imports crossing into `engine/`, `ui/`, `debug/` from shared-bound code

Only **eight**, across 135 files:

| From | To |
|---|---|
| `world/MapLoader.ts:2` | `engine/ProceduralTextures` (type) |
| `world/MapLoader.ts:3` | `engine/Renderer` — `rememberShadowAuthoring`, `SHADOW_TIERS` (**value import**) |
| `weapons/WeaponAudio.ts:3` | `engine/ProceduralAudio` (type) |
| `ai/BotMesh.ts:5` | `ui/Palette` |
| `streaks/KillstreakBase.ts:7,8` | `engine/CameraRig`, `engine/Fx` (types) |
| `streaks/StreakAudio.ts:1,2` | `engine/AudioSpecs`, `engine/ProceduralAudio` |
| `equipment/EquipmentAudio.ts:2` | `engine/ProceduralAudio` (type) |

`world/MapLoader.ts:3` is the only value-level import and the only one that would survive
`verbatimModuleSyntax` erasure — it is the one that would actually break a Node import.

`core/Events.ts` also imports `GameStateId` from the root-level `GameStates.ts` — the client
state machine's type leaking into the shared event bus. Minor, but it is an inversion.

---

## 6. Simulation state and render state as the same object

§6.1 predicted this would be the expensive category. It is real but narrower than feared.

### 6a. `Bot` owns a `BotMesh` — the one true offender

`ai/Bot.ts:84` — `readonly mesh: BotMesh`, constructed at line 157. Eight call sites:

```
Bot.ts:281  this.mesh.endDeath()
Bot.ts:282  this.mesh.setVisible(true)
Bot.ts:312  this.mesh.beginDeath(dx, dz, this.rng.int(0, DEATH_VARIANTS))
Bot.ts:324  this.mesh.flinch(dx, dz)
Bot.ts:404  this.mesh.advance(dt)
Bot.ts:406  this.mesh.apply(x, y, z, yaw, heightScale)
Bot.ts:429  this.mesh.dispose()
BotDirector.ts:371,388  groupFor(team).add|remove(bot.mesh.group)
```

The coupling is **one-way** — `apply(x, y, z, yaw, heightScale)` writes sim state into the mesh
and nothing reads back. So this is containment, not shared ownership: the field is deleted and
the client's bot renderer pulls transforms from the roster instead. `ai/Bot.ts` itself imports
no Three and is otherwise clean.

**One determinism hazard hides here.** `Bot.ts:312` draws `this.rng.int(0, DEATH_VARIANTS)`
from the bot's simulation RNG *purely to pick a death animation variant*. A headless server has
no animation but must still make that draw, or the RNG stream diverges from the browser's. This
is precisely the §4.14 failure mode, found in M9 rather than M10 — and it is an argument for
per-event seeding over free-running streams, not just a bug to patch.

### 6b. `StreakContext` hands every streak the renderer

`streaks/KillstreakBase.ts` — the context interface carries `scene: THREE.Scene`, `fx: Fx`,
`cameraRig: CameraRig`, `audio: StreakAudio` and a `blast()` callback alongside genuinely shared
fields (`bus`, `world`, `damage`, `bots`, `mapDef`, `cfg`, `rng`, `roster`, `targetable`,
`visibleToUav`, `nextEntityId`). The file's own docstring says *"a streak owns its own scene
objects and takes them apart in `onExpire`"* — that design is correct for a browser game and is
exactly what M9 has to undo. `onTick`/`onRender` are already separated, which makes the cut
cleaner than it first looks.

### 6c. `Match.simulate()` reaches into presentation

Six calls inside the tick, at `Match.ts:761–872`:

| Line | Call | Nature |
|---|---|---|
| 769 | `stepMortarOverlay(cmd)` | drives a DOM overlay **and gates input** |
| 825 | `deps.input.addViewOffset(...)` | sim writes recoil residual back into the browser input object |
| 860 | `stepLowHealthAudio()` | reads `this.ui.lowHealthIntensity` (**HUD is the source of truth for a sim-consumed value**) and calls `audio.setMuffle` / `playHeartbeat` |
| 863,865 | `performance.now()` | metric |
| 868 | `ui.setScoreboardOpen(...)` | HUD write |
| 871 | `latency.expire(performance.now())` | debug probe |

`stepInteractPose()` (line 953) looked like a presentation call and is not — it is pure sim.

`MatchDeps` itself carries `scene: THREE.Scene`, `viewmodel`, `cameraRig`, `audio`, `input`,
`uiHost: HTMLElement` and `anisotropy` alongside the shared world, player, configs and mode.

### 6d. Not offenders — verified clean

`PlayerSim`, `PlayerSnapshot`, `Combatant`, `HitboxRig`, `Contact`, `RayHit`, `Projectile`,
`ObjectiveZone`, `CollisionWorld`, `SpatialHash`, `NavGrid`, all `world/maps/*` data, and
`PlayerController` (which imports nothing outside `core/`, `world/` and `player/`). The M1
decision to carry poses as loose scalars is what makes this milestone tractable.

---

## 7. Determinism (§4.14 / §6.6 groundwork)

- **`Math.random()` appears zero times in gameplay code.** The only textual match is a comment
  in `weapons/WeaponSystem.ts:212` stating the ban. `Date.now()` and `new Date()` are likewise
  absent from shared-bound code.
- **Free-running RNG streams that reconciliation will replay through**, and which §4.14 says
  must become per-event derived seeds:
  - `weapons/WeaponSystem.ts:136` — spread and pellet cones (`:373`, `:390`, `:397`).
    `Recoil.ts:197,198` draws two floats per shot from this stream.
  - `ai/Bot.ts:137` — per-bot stream, seeded from `spec.seed` (includes the cosmetic death-variant
    draw in 6a).
  - `ai/BotDirector.ts:250`, `Match.ts:515`, `MatchEquipment.ts:110`.
  - `WeaponSystem.ts:214` already has a `reseed(seed)` path, which is a usable hook.
  - The remaining `new Rng(...)` sites (`Camos`, `WeaponMesh`, `MapMesher`, `Particulate`,
    `WeaponAudio`, `EquipmentAudio`, `EquipmentFx`) are all cosmetic and all client-bound.
- `Rng` already exposes `saveState`/`loadState`, which the cross-runtime hash tool can use.

---

## 8. Tooling gaps that block the acceptance criteria

Found while auditing; each is a prerequisite, not a nice-to-have.

1. **`tsconfig.json` declares `"lib": ["ES2022", "DOM", "DOM.Iterable"]` globally.** As long as
   one config covers the whole tree, the type system will *never* catch a DOM reference in
   `shared/`. The partition needs per-target configs — `shared/` compiled without `DOM`, and
   `server/` with `@types/node` instead. Without this, §6.3's boundary check is the only guard,
   and it checks imports, not globals.
2. **There is no CI.** No `.github/`, no workflow. §3 and §6.3 say "enforced in CI, not by
   discipline" — that CI has to be created, not extended.
3. **No linter, no test runner, no dependency-boundary tool installed.** `dependency-cruiser`
   (or an ESLint boundaries rule) is a new dependency; §2 permits it as tooling.
4. **`@types/node` is not installed**, and `npm run server` does not exist. `package.json` has
   only `dev`, `build`, `preview`, `typecheck`.
5. **`vite.config.ts` pre-bundles `three` and `BufferGeometryUtils`.** Harmless for the client;
   noted so the server build is kept off Vite entirely.
6. **`debug/Harness.ts` is already headless** — it imports only `core/`, `player/`, `world/` and
   drives `PlayerController` against a hand-built `ColliderSet`. It is the natural seed for the
   §6.6 cross-runtime hash tool. `debug/MatchHarness.ts`, by contrast, drives the browser `Game`
   and does not port.

---

## 9. Where the brief's §3 tree does not match the code

Flagged now because the partition has to resolve them:

- **`equipment/` has no home in §3's tree.** Ten files, 2,338 lines — grenades, smoke, flash,
  projectiles, the thrower, and bot throwing. It is gameplay and it is server-authoritative;
  it needs a `shared/equipment/` that §3 does not list.
- **`§3 puts `perks/` wholly in `shared/`**, but `PerksRuntime.ts` builds meshes (see 1c).
- **`§3 puts `streaks/` in `shared/` as "logic only"** — correct as an end state, but every one
  of the six currently receives the renderer through `StreakContext`.
- **`combat/TargetRange.ts` and `combat/TargetDummy.ts`** (the M2 shooting range, 30k) are
  testbed content, not combat systems. §3 has no slot for them; they are client-bound.
- **`Match.ts` is 69,319 bytes / ~1,550 lines** and is named the same as `server/Match.ts` in
  §3's tree. The server's `Match.ts` is a different, much smaller thing. The existing file is
  the *client's* match composition root and should not inherit the name unchanged.

---

## 10. Scope estimate

| Category | Files | Assessment |
|---|---|---|
| Already clean, move as-is into `shared/` | 106 | mechanical |
| Client-only, move as-is into `client/` | ~16 | mechanical |
| Genuinely split | 13 | `MapLoader`, `Loop`, 4 streaks + `KillstreakBase`, `PerksRuntime`, `BotDirector`, `TargetDummy`, `TargetRange`, `Camos`, `SaveData`, `Match` |
| Clock abstraction only | 5 | `AiScheduler`, `NavBake`, `MapLoader`, `StreakSystem`, `DamageSystem` |
| New code | — | `shared/core/Clock`, `server/Loop`, `server/Match`, `server/main`, logging, boundary config, per-target tsconfigs, CI |

The dominant risks are **`Match.ts` and `StreakContext`**, in that order. Everything else is
carrying boxes.
