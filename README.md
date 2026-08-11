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
npm run check
```

`check` is the gate: the target-boundary check, then a typecheck of each of the three targets
separately. `npm run build` runs it before building.

```bash
npm run build
```

Requires Node 18+ and a Chromium-based browser. The game needs pointer lock, which means it
needs a click to start and a secure context (`localhost` counts).

### The headless server (M9)

The simulation runs without a browser. This boots, loads Foundry, plays a ten-bot Team
Deathmatch to its win condition at a real 60 Hz, logs the result and exits:

```bash
npm run server
```

A match is four to five minutes of simulated time, and paced mode takes that long in wall
clock — which is what a server does. For a stability run, `--asap` drops the pacing and runs
five matches in about eight seconds, logging one JSON record per match boundary with the
result, sim cost, heap and per-tier bot hit rate:

```bash
npm run harness
```

Anything else is flags: `--map mp_depot --mode DOM --bots 10 --tier VETERAN --seed 7
--minutes 10 --json`.

### Proving both runtimes agree

The same fixed sequence of input commands, through the same `shared/` modules, in Node and in
the browser. The per-tick state hashes must match exactly.

```bash
npm run hashes
```

Then in the browser console: `__operator.determinism.download()`, and

```bash
node scripts/diff-hashes.mjs node-hashes.json browser-hashes.json
```

It reports the first divergent tick and the field that differs — and reports a *maths*
disagreement first when there is one, because that causes the state divergence. See
`src/shared/core/SimMath.ts` for why `Math.sin` and `Math.cos` are banned in `shared/`.

---

## Multiplayer (M10)

The game runs against a **dedicated headless server**. There is no host player and no listen
server: every player is a client, including whoever started it.

### Playing against a server

```bash
npm run serve
```

Then open the client with a `?server=` flag:

```
http://127.0.0.1:5173/?server=127.0.0.1:8080&name=ALICE
```

Open it twice, in two windows, with different names — that is a two-player match. Without
`?server=` the game boots into single-player exactly as it did before, which is deliberate:
nothing about this milestone changes what happens when you just open the page.

| Flag | Effect |
|---|---|
| `?server=host:port` | Connect to that server |
| `?server=1` | Connect to this page's own origin at `/ws` |
| `?name=ALICE` | Name on the scoreboard |
| `?net=100` | Add 100 ms round trip *on top of* the real link |
| `?net=bad` | The 100 ms ±30 ms jitter, 2% loss preset |
| `?net=250,40,5` | Latency, jitter, loss — explicitly |
| `?rewinddebug=1` | Ask the server for the per-shot rewind feed |

**F1** opens the overlay; the **Network**, **Prediction** and **Rewind** sections are the M10
read-outs. If prediction is working, `Mispredictions` reads `0` at any latency — the number
counts *wrong* predictions, not corrections owed to the network.

### Testing it without two people

```bash
npm run netharness -- --url ws://127.0.0.1:8080 --clients 2 --seconds 60 --net 100
```

Headless clients that run the **real** client netcode — the same `NetClient`, `Prediction`
and `EntityInterpolator` a browser runs, behind a Node socket instead of a browser one. Every
client-side number in the milestone report comes out of this.

```bash
npm run netharness -- --url ws://127.0.0.1:8080 --hittest --seconds 40 --net 150
npm run netharness -- --url ws://127.0.0.1:8080 --harden
npm run netharness -- --url ws://127.0.0.1:8080 --disconnect hard --seconds 20
```

`--hittest` is the controlled hit-registration experiment: one shooter, one strafing target,
a fixed 10 m range. Run it against a server started with `REWIND_DISABLED=1` to measure what
lag compensation is actually worth rather than asserting it.

`--harden` fires the S8.12 probes — garbage, truncated frames, oversized frames, a bad
version, a flood — and reports whether the server is still accepting connections afterwards.

### Deploying it

The server is a single Node process. Build it, copy it, run it under systemd.

```bash
npm run build:server
rsync -a dist-server package.json node_modules/ws user@host:/opt/operator/
```

```bash
sudo cp deploy/operator.service /etc/systemd/system/
sudo cp deploy/operator.env /etc/operator.env    # edit this
sudo systemctl daemon-reload
sudo systemctl enable --now operator
```

| | |
|---|---|
| **Restart** | `sudo systemctl restart operator` |
| **Stop** | `sudo systemctl stop operator` — clients get a `Bye` with a reason, not a dead socket |
| **Logs** | `journalctl -u operator -f` |
| **Metrics** | `journalctl -u operator -o cat \| jq 'select(.event=="metrics")'` |
| **Config** | `/etc/operator.env`, then restart |

Everything operational — address, port, snapshot rate, bot count, interpolation delay — comes
from that env file. Nothing is hardcoded.

#### What the server actually runs (M11)

One process holds **two worlds**. There is no lobby, no queue and no ready-up.

- A **permanent warmup arena** — the greybox room, free-for-all, damage live, instant respawn,
  three bots and the target dummies. It exists from boot to shutdown and is where every player
  lands. Clicking *Play Multiplayer* puts you in it within one round trip.
- At most one **live match**, allocated when a vote resolves and destroyed completely when it
  ends.

A 60-second cycle runs continuously in the arena: 40 s of free play, 10 s to vote on a mode,
10 s to vote on a map. The overlay is non-blocking — you keep moving and shooting through it —
and voting is **keyboard only**: press 1-5. There is no click target, because the game holds
pointer lock and a click on the overlay is a click the browser has already delivered to the
canvas as a shot. When the map is decided your browser starts building it in the
background while you are still playing, so the transition into the match has no loading screen.

| Setting | Default | What it does |
|---|---|---|
| `WARMUP_BOTS` | 3 | Bots in the arena |
| `PLAY_SECONDS` | 40 | Free play before the ballot opens |
| `MODE_VOTE_SECONDS` | 10 | |
| `MAP_VOTE_SECONDS` | 10 | |
| `READY_TIMEOUT_MS` | 20000 | How long a slow client's background build is waited on before the match starts without it. Paired with the client's per-frame build budget — see `MapBuildQueue` |
| `SUMMARY_HOLD_SECONDS` | 14 | How long the post-match summary is held before everybody returns |
| `FAULT_INJECTION` | off | Diagnostic only. Lets the allocator be made to stall and fail |

Shortening the vote timings is supported and is a **diagnostic setting, not a tuning knob** —
see `DEBUG.md` for why a harness that shortens a timer can shorten past the bug it exists to
find.

#### TLS

A browser **will refuse a plaintext `ws://` socket from an `https://` page.** If the client is
served over HTTPS the server must be `wss://`, and there is no way around it. Two ways:

**Terminate at a reverse proxy** (recommended — one certificate, one hostname, no CORS):

```
# Caddy
play.example.com {
    root * /opt/operator/dist
    file_server
    reverse_proxy /ws localhost:8080
}
```

With that layout the client needs no configuration at all: `?server=1` resolves to the page's
own origin and `/ws` reaches the server. Leave `TLS_CERT` and `TLS_KEY` blank and `HOST` on
loopback.

**Or terminate in Node** — set `TLS_CERT` and `TLS_KEY` to PEM paths and bind a public
interface. Simpler to reason about, but the certificate renewal is then yours to arrange.

#### A note on progression — read this one

There is no server database (S4.16). XP and unlocks stay in the browser's `localStorage`, so
progression is **per-device and per-browser** and a player who clears site data loses it.
That is a deliberate consequence of having no accounts, and it is written down here rather
than left to be discovered.

**It also means a player can edit their own unlocks.** The save is a JSON blob in their own
browser; nothing stops anybody opening the console and granting themselves level 55. From M11
the server accepts whatever class a client sends and validates only that the ids are *real* —
`sanitiseNetLoadout` checks a weapon exists, and deliberately cannot check whether the player
earned it, because the server has no profile to check against.

This is a **known and accepted trade**, not an oversight:

- It affects only the player who does it. Progression gates *which* gun you may bring, and every
  gun is balanced against every other — there is no pay-to-win ladder to climb, because there is
  nothing above the twelve weapons everybody can eventually field.
- The alternative is server-side accounts and a database, which S4.16 and S9 put out of scope,
  and which would be a large amount of machinery to protect a number that decides nothing about
  who wins a gunfight.
- Everything that *does* decide a gunfight — position, health, damage, hit registration, ammo,
  scores, objective state — is server-authoritative and is not editable from the browser at all.

So: a player can arrive with a weapon they have not unlocked. They cannot arrive with more
health, a faster gun, or a hit that did not happen.

---

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
