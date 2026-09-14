# Character asset pipeline

The character system deliberately separates asset data, I/O, and per-actor behaviour:

```text
Game (application lifetime)
              |
              v
CharacterAssetService (shared cache owner + preload)
              |
              v
CharacterAssetRepository (fetch/parse/cache: one skin per character, one animation file per URL)
              |
              v
CharacterAssetImport (pure: validate the skin, select/scale/lock each clip for this rig)
              |
              v
CharacterAvatarProviderResolver (one stable provider per rendered actor)
              |
              v
CharacterAvatarProvider (match-scoped factory + graceful fallback)
              |
              v
CharacterAvatarFactory (SkeletonUtils.clone, synchronous)
              |
              v
CharacterAvatar = CharacterSkin + CharacterAnimator
              |
              v
BotRenderer (roster reconciliation, events, scene ownership)
```

`shared/` supplies only `RenderableActor` poses, replicated event serials, and an
`ActorAnimationInput`. It must never import Three.js or let a skeleton modify a hitbox. The
outer actor transform continues to come from the authoritative simulation/interpolator.
`BotRenderer` receives only a small `CharacterAvatarProviderResolver` interface. `Game`
owns one `CharacterAssetService` for the lifetime of the application, warms the default bundle
during BOOT/MENU, and resolves a lightweight provider for each rendered actor. Match teardown
releases avatars and their providers, but not successfully parsed GLB templates.

## Current supplied assets

Seven compatible bot skins are explicitly registered in `CharacterCatalog`: `Apex`, `Echo`,
`Hazard`, `Pulse`, `Rhino`, `Sentry`, and `Viper`. They use compatible Mixamo landmarks
and textures no larger than 2048px. `Hazard` is the largest at 37.56 MiB; `Echo` and
`Viper` are also relatively heavy because they use several 2K diffuse and normal maps.

- `Apex.glb` has a 0.001 armature root while its bones use the centimetre-scale unit of the
  regular animation exports. Its dedicated rig profile scales cloned animation translation tracks
  and the support-palm marker at the asset boundary; do not change gameplay transforms or add a
  renderer special case for it.
- The app-lifetime cache intentionally keeps a successfully rendered template alive across mode
  changes. A busy roster can therefore load several of the six skins and retain substantial GPU
  texture memory. Assets are loaded on demand — the game warms only `Echo`, never preloads the
  entire catalogue — but a production cosmetic system still needs quality tiers and an LRU budget.
- `RandomCharacterSelector` deals a new shuffled deck for each Match. The first seven rendered
  actors receive distinct skins; an actor keeps its assigned skin across fallback-to-GLB
  upgrades and respawns. It deals to every rendered actor, humans included. The deck is drawn
  from a seeded `Rng` rather than `Math.random` — `Game` seeds it from the save's lifetime
  match count and the session's build count, so consecutive matches differ and any one match
  is reproducible from its save. It is still presentation-only and client-local, so separate
  multiplayer clients will not agree on it until the server replicates a `characterId`.
- The animation set is shared by every Mixamo-rigged skin, and the repository caches it that
  way: one fetch and one parse per animation URL, for the page lifetime. What is per skin — the
  Apex unit scale, the root lock against that skin's bind pose, and the track set (a track for
  a bone the skin lacks is dropped rather than left to bind to nothing) — is done on a clone by
  `CharacterAssetImport.importClip`, which is cheap. Before this, each of the seven skins
  re-fetched and re-parsed all eleven files and held its own copy of every clip.
- **The library is a folder of slots** (M13 Phase D): `public/models/bots/animations/` is
  `locomotion/{stand,crouch,slide}/`, `transitions/`, `actions/`, `deaths/`, `hits/` and
  `incoming/`, with a README that says what each means. The catalogue names a **slot**
  (`CharacterAnimationId`) as an array of **variants**; the selector returns a slot and never
  learns how many clips stand behind it. Variants are dealt by `AnimationVariant.variantFor`
  from `(entityId, spawnSerial)` for a life, and deaths by the simulation's own `deathVariant`
  modulo the slot's count — never at random, so every client draws the same body the same way.
  `npm run check:animations` holds the catalogue and the folder to each other in the gate.
- A Mixamo session export contains every animation of the session as cumulative clips named
  `mixamo.com.NNN` rather than one semantic clip (the first is a 0.017 s placeholder). Every
  file in the library is passed through `scripts/animation-import.mjs`, which keeps the one
  clip the file is named for and meets the contract below — the original eleven were rewritten
  in place on 2026-09-14 — and `scripts/animation-manifest.mjs` reads what is actually in any
  file first.
- All clips include `mixamorigHips.position` root motion. The loader locks only the configured
  planar components to the skin bind pose so it cannot drift relative to the network pose. For
  the current Mixamo export, local `Z` maps to rendered vertical height and must remain live for
  crouches and death clips to reach the floor; re-export in-place loops anyway.
- The source skin and action files have small rest-pose differences. Validate the result in a
  browser before accepting cross-fades.
- The current source folder is tracked through Git LFS. A deployment/build environment must pull
  LFS objects (or deliberately host the assets on a CDN) before it can serve these URLs.
- This is currently bot-only presentation selection. A player-specific skin needs a
  server-validated, replicated `characterId`; it must not be chosen locally from an arbitrary
  URL. That future value can override the deterministic fallback at the composition root without
  making the renderer know about profiles or networking.
- The procedural body has four directional death variants, dealt by the simulation as
  `deathVariant`. The skinned body indexes its death slot by the same number: two standing falls
  today (`deathStand` has two variants), one crouched. `check:animations` keeps `DEATH_VARIANTS`
  a multiple of every death slot's count so the variants are dealt evenly.
- A reload is drawn (`reloadStand` / `reloadWalk` / `reloadCrouch`, keyed on
  `ActorAnimationInput.reloading`) and fitted to the weapon's reload time through
  `reloadSeconds`; the support-hand constraint is released for it. Throws and melee wait for
  their snapshot bits.

The catalogue asks for a clip by name and nothing else; the legacy "last clip plus expected
duration" adapter the original files needed is gone with them.

## Required export contract

Export each animation as an animation-only GLB containing exactly one clip, **named after the
file** — `deaths/Death_Stand_01.glb` holds one clip called `Death_Stand_01` — on the skins'
65-bone skeleton where possible. `scripts/animation-import.mjs` turns a Mixamo session export
into that shape; the catalogue then names the file as `'deaths/Death_Stand_01'` and asks for
the clip by that stem. Every skin must satisfy its `CharacterRigProfile`:

- the required named bones and compatible bind/rest pose;
- an explicit weapon hand/socket and calibrated transform;
- scale/orientation checked against `HUMANOID_RIG`;
- in-place locomotion (or a documented root-motion policy);
- texture/mesh budgets suitable for the target GPU.

Use KTX2/Basis texture compression, reduced texture resolution, mesh compression, versioned
asset URLs, and Git LFS or a CDN for production delivery. Load only reviewed, selected assets
during a loading/warmup phase; `BotRenderer` keeps the procedural body only as a non-blocking
fallback while that work is in flight or fails. It creates or upgrades at most two GLB avatars
per render frame so a ready template cannot synchronously replace an entire roster. This
amortizes cloning; it does not remove the need for a texture budget when many cosmetics are in
play.

The catalog version is part of both the repository cache key and the public asset query string.
Bump it whenever an exported file changes. This is a simple browser-cache guard; a content-hashed
CDN manifest remains the stronger production solution. A failed load intentionally falls back for
the current match rather than retrying from the render loop. The repository evicts failed requests,
so a later Match or an explicit `CharacterAssetService.retry` can make one bounded retry without
discarding successful templates for other characters; a live provider observes a successful retry
and upgrades its fallback body on the renderer's normal frame budget.

## Animation policy

`AnimationSelector` maps semantic state to slot ids; it has no file paths or Three.js objects,
and it does not know how many variants a slot holds. A slot that does not exist must fall back
to a known locomotion pose. Do not introduce type checks such as `actor instanceof Bot`: both
local bots and remote players satisfy the same `RenderableActor` contract.

The supplied `Idle_Relaxed` and `Walk_Relaxed` clips are not firearm-holding poses. Until
dedicated hip-ready exports arrive, the catalog names the reviewed armed clips
`idleWeaponReady`/`walkWeaponReady` even though their source filenames say `Aiming`; the
selector chooses them for a body that actually carries a weapon. The weapon mesh supplies its
own trigger-grip anchor, while the rig catalog supplies only the hand-axis calibration. This
keeps weapon-class geometry and character-rig alignment independent.

`AnimationMixer` and `AnimationAction` are per avatar. Parsed clips, source geometry, source
materials, and textures are shared and remain authored: teams never recolour a skin. Viewer-
relative IFF lives in the separate client-only actor-indicator layer instead — two lit shoulder
pads on a hostile body (M13 C3), plus a nameplate and continuous segmented health bar above the
visible body. Every colour in that layer comes from `ui/Palette` and repaints when the palette
changes, so a colourblind mode reaches the body in front of the player the same way it reaches
the minimap dot; none is written in the indicator itself. This keeps a future skin pack
independent of team presentation.

The third-person weapon arrives at the avatar as one `HeldWeaponAsset` — geometry, material and
the two semantic anchors from the weapon layout, built together by `buildHeldWeapon` and joined
to the avatar contract in `BotRenderer`, so `characters/` never looks anything up in
`weapons/` by id. `gripAnchor` (the trigger hand) is the point placed at the animated right-hand
socket, and `supportAnchor` marks the physical support grip. `WeaponSupportHandConstraint` runs
after the mixer only for clips the catalog marks `weaponReady` and rotates the cloned left upper
arm/forearm until a rig-specific virtual palm marker meets that support grip. It is deliberately a visual constraint: it cannot move the authoritative actor transform,
does not run during deaths or relaxed sprint clips, and does not alter shared skeleton templates.
