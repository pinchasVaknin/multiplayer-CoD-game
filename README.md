# OPERATOR

A browser-based arena FPS. Bots, progression, loadouts, killstreaks, five modes and three
maps, playable end to end from the main menu to the post-match board.

**Zero external assets.** Every mesh is built from primitives in code, every texture is a
`CanvasTexture` painted from seeded value noise, and every sound is synthesised through the
Web Audio API — oscillators, noise buffers, filters, envelopes and a convolution reverb
whose impulse response is generated per map. There are no model files, no texture packs, no
audio files and no webfonts. The whole build is TypeScript, Three.js and Vite.

---

## Setup

```bash
npm install
```

```bash
npm run dev
```

Then open <http://127.0.0.1:5173>. Click **Play**, pick a mode and a map, and press
**Start match**.

```bash
npm run typecheck
```

```bash
npm run build
```

Requires Node 18+ and a Chromium-based browser. The game needs pointer lock, which means it
needs a click to start and a secure context (`localhost` counts).

### Press F11

Chrome reserves `Ctrl+W` and ignores `preventDefault`, so crouch-plus-forward closes the tab
in a windowed page. The only mechanism that captures it is the Keyboard Lock API, which is
granted only while the document is fullscreen. Play fullscreen.

---

## Controls

Every one of these is rebindable in **Settings → Bindings**, including the mouse buttons and
the wheel. The defaults:

| | |
|---|---|
| `W A S D` | Move |
| `Shift` | Sprint — double-tap for tactical sprint |
| `Ctrl` / `C` | Crouch; with sprint, slide |
| `Space` | Jump, mantle |
| Left mouse | Fire |
| Right mouse | Aim down sights |
| `R` | Reload |
| `Q`, wheel | Swap weapon |
| `1` / `2` | Primary / secondary |
| `G` / `F` | Lethal / tactical — hold to cook, release to throw |
| `X` | Field upgrade |
| `3` / `4` / `5` | Killstreaks one, two and three |
| `E` / `P` | Use — pick up the bomb, plant, defuse, take a care package |
| `Tab` | Scoreboard |
| `Esc` | Pause |
| `F1` | Debug overlay |

Sprint into a waist-high ledge and you vault it without pressing anything. Sprint, crouch,
and you slide; jump out of the slide to keep the speed.

---

## What is in it

**Three maps.** *Foundry* is an industrial three-laner with a catwalk deck four metres up.
*Dunes* is a desert village whose outer streets run the full seventy-two metres of the map —
the sight lines are the point — with 4 m alleys through the middle as the real alternative.
*Depot* is a night cargo yard built around climbing: container roofs at 2.6 m, stacks at
5.1 m and a gantry bridge at 5.2 m, with every step between them inside the 1.6 m mantle
window.

**Five modes.** Team Deathmatch, Domination, Kill Confirmed, Free-for-All and Search &
Destroy, plus a Shooting Range with every weapon unlocked.

**Twelve weapons** across six classes with attachments and camos, **six killstreaks**,
**twelve perks**, field upgrades, lethal and tactical equipment, and a progression system
with levels, prestige and challenges — all of it in a versioned save that migrates rather
than resets.

**Bots** that patrol, hear you, take cover, flank, play the objective, and — on Depot —
climb.

---

## Architecture

```
src/
  core/       Loop, Input, Keybinds, EventBus, ObjectPool, Rng, SaveStore, Transport
  engine/     Renderer, MotionBlur, CameraRig, ProceduralTextures, ProceduralAudio,
              AudioGraph, AudioMix, Fx, Decals
  world/      CollisionWorld, SpatialHash, Navmesh, MapLoader, Particulate, maps/*
  player/     PlayerController, Movement, Stance, Slide, Mantle, Health, CameraShake
  weapons/    WeaponBase, WeaponDefs, Recoil, Ballistics, Attachments, ViewmodelAnim
  combat/     DamageSystem, HitboxRig, Killfeed, ScoreSystem
  ai/         BotBrain, Perception, Pathing, CombatBehaviour, DifficultyTiers, AiScheduler
  modes/      GameMode + TDM, Domination, FFA, SearchAndDestroy, KillConfirmed, Range
  meta/       Profile, Levels, Loadouts, Unlocks, Challenges, Camos, SaveData
  streaks/    KillstreakBase + UAV, CounterUAV, CarePackage, Mortar, Sentry, ChopperGunner
  perks/      Perk definitions and effect hooks
  ui/         Hud, Minimap, Menus, Settings, Palette, LoadoutEditor, Scoreboard, EndOfMatch
  debug/      DebugOverlay, FrameStats, Handover, SnagHarness, and the panels
  Game.ts     BOOT -> MENU -> LOADOUT -> SETTINGS -> MATCH -> PAUSED -> SUMMARY
```

Four ideas hold the whole thing together, and they are worth knowing before changing
anything.

**The simulation is a fixed 60 Hz.** `dt` is the constant `1/60` and nothing in gameplay
ever multiplies by a frame delta. `Loop` accumulates, runs up to five sim steps per frame,
and discards a longer backlog rather than spiralling; rendering interpolates between the
previous and current state. A retuned number behaves identically at 15 fps and 144 fps
because there is nothing frame-rate-dependent for it to behave differently with.

**Input is commands, not polling.** No gameplay code reads the DOM or a key map. `Input`
samples one immutable `InputCommand` per tick — move axes, absolute yaw and pitch, and a
button bitfield — and `PlayerController.step(cmd)` consumes exactly one. Edge detection
happens in the sim from the bitfield. A bot is a *different source of the same command*,
which is why bots get recoil, spread, sprint-to-fire and reloads for free, and why the
`INetworkTransport` seam is real rather than decorative. Rebinding resolves a physical input
to a **bit** for the same reason: a rebound key must travel the identical path a default one
does.

**One collision scheme, one spatial structure.** Swept capsule against oriented boxes, in a
uniform 4 m spatial hash, with a hand-written raycaster over that same hash. The navmesh
asks the collision world whether a capsule fits, so it can never disagree with movement.
`THREE.Raycaster` is not used in gameplay.

**Everything that recurs is pooled, and every pool has a cap.** Tracers, decals, particles,
damage numbers and audio voices. The caps are not decoration: an uncapped voice pool was a
real bug that cost a tenfold slowdown in the AI budget (`PLAN.md`, M3).

Systems talk through a typed `EventBus` and never reach into each other.

---

## Tuning guide

**Every number that affects feel lives in a config file, never inline in logic.** This is
the map from "I want to change X" to the file that owns it.

### Movement and camera

| To change | Edit |
|---|---|
| Walk / sprint / tactical-sprint speed, acceleration, friction | `player/MovementConfig.ts` |
| Slide duration, speed, cooldown, the jump-cancel rules | `player/MovementConfig.ts` |
| Mantle and vault heights, reach, ledge limits | `player/MovementConfig.ts` |
| Capsule radius and the three stance heights | `player/MovementConfig.ts` |
| FOV, view bob, landing dip, sprint roll, shake decay | `player/CameraConfig.ts` |

Both are exposed as live sliders in the F1 overlay, and **COPY CONFIG** writes the result
back out as source you can paste over the defaults.

### Weapons

| To change | Edit |
|---|---|
| Damage, falloff, rate of fire, magazine, ADS time, penetration | `weapons/defs/*.ts` |
| Recoil pattern, spread cone, recovery | the `recoil` block of a `WeaponDef` |
| How a gunshot *sounds* — the four layers | the `voice` block of a `WeaponDef` |
| Where the gun sits, ADS pose, sway, reload keyframes | `weapons/ViewmodelConfig.ts` |
| Attachment effects | `weapons/Attachments.ts` |
| Headshot and limb multipliers | the `WeaponDef`; the *zones* are `combat/HitboxRig.ts` |

### Bots

| To change | Edit |
|---|---|
| Aim cone, reaction time, convergence, burst length, engage range | `ai/DifficultyTiers.ts` |
| Vision cone, ranges, hearing | `ai/DifficultyTiers.ts` (`DEFAULT_PERCEPTION`) |
| How often a bot thinks, paths and perceives | `ai/AiScheduler.ts` |
| Which weapon a tier draws | `ai/BotArsenal.ts` |
| Mantle cost in pathfinding | `CLIMB_COST_METRES` in `ai/Pathing.ts` |
| How far a bot will step off a ledge | `NAV_DROP_HEIGHT` in `ai/BotDirector.ts` |

### Modes, streaks, progression

| To change | Edit |
|---|---|
| Score limits, round length, respawn delay | `modes/*.ts` |
| Capture rate, flag radius, bomb timers | `modes/ObjectiveZone.ts`, `modes/SearchAndDestroy.ts` |
| Streak requirements, durations, damage | `streaks/StreakDefs.ts` |
| XP awards and the level curve | `meta/XpRules.ts`, `meta/Levels.ts` |
| Perk effects | `perks/PerkDefs.ts` |
| Grenade damage, radius, cook time, flash duration | `equipment/EquipmentConfig.ts` |

### Maps

| To change | Edit |
|---|---|
| Geometry, spawns, objectives, lighting, fog, reverb | `world/maps/<map>.ts` |
| The prop catalogue | `world/maps/props.ts` |
| What cover a prop offers | `COVER_PROFILES` in `world/maps/cover.ts` |
| Wall penetration, impact and footstep character per material | `world/maps/materials.ts` |
| What a material *looks* like | the painters in `engine/ProceduralTextures.ts` |
| Dust and haze | the `particulate` block of a `MapDef` |
| Which maps and modes the menu offers | `modes/ModeRegistry.ts` |

A map needs no navmesh authoring — the bake reads the collision world — but it does need
honest `navBounds`, because that is the volume the bake walks.

### Audio and presentation

| To change | Edit |
|---|---|
| Per-source levels, and how fast each category falls off with distance | `engine/AudioMix.ts` |
| Bus structure, reverb send, the low-health muffle, the announcer duck | `engine/AudioGraph.ts` |
| Gameplay colours, including every colourblind palette | `ui/Palette.ts` |
| Spacing, type scale, the one accent colour | `ui/styles/tokens.css` |
| Shadow tiers | `SHADOW_TIERS` in `engine/Renderer.ts` |
| Motion-blur strength | `STRENGTH` in `engine/MotionBlur.ts` |

**If you change one number, change it in the config file.** A number written at a call site
is a number the tuning panel cannot reach and the next person cannot find.

---

## Settings

Everything in **Settings** does something, immediately, and persists. Mouse sensitivity, a
separate ADS multiplier, FOV from 60 to 120, invert Y, full rebinding of every action
including mouse buttons and the wheel, master / effects / music / interface volume on their
own buses, render scale, shadow quality, an FPS counter, motion blur, and a colourblind mode
that changes the actual team colours, hitmarkers, minimap dots and objective rings rather
than filtering the picture.

---

## Debugging

`DEBUG.md` documents every panel, harness and console tool, with a worked example of using
each to answer a real question. The short version: **F1** opens the overlay, and
`window.__operator` is the console surface everything is measured through.
