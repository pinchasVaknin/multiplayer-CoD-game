# Character asset pipeline

The character system deliberately separates asset data, I/O, and per-actor behaviour:

```text
CharacterCatalog (semantic IDs + rig contract)
              |
              v
CharacterAssetRepository (one fetch/parse/cache per asset)
              |
              v
CharacterAvatarProvider (preload lifecycle + graceful fallback)
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
`BotRenderer` receives only the small `CharacterAvatarProvider` interface; the concrete GLTF
loader is assembled in `ClientMatch`, the composition root.

## Current supplied assets

The current `tactical_soldier` skin and animation files use a compatible 65-joint Mixamo rig,
which is a good starting point. They are not ready to be treated as a production asset pack:

- The skin is approximately 117.56 MiB and embeds nine 4096px PNGs. The complete current
  character directory is approximately 124.48 MiB.
- Each nominal animation file contains multiple cumulative clips named `mixamo.com` rather than
  one semantic clip. The first clip is a 0.017s placeholder, so `animations[0]` is incorrect.
- All clips include `mixamorigHips.position` root motion. The loader locks only the configured
  planar components to the skin bind pose so it cannot drift relative to the network pose. For
  the current Mixamo export, local `Z` maps to rendered vertical height and must remain live for
  crouches and death clips to reach the floor; re-export in-place loops anyway.
- The source skin and action files have small rest-pose differences. Validate the result in a
  browser before accepting cross-fades.
- The current source folder is tracked through Git LFS. A deployment/build environment must pull
  LFS objects (or deliberately host the assets on a CDN) before it can serve these URLs.
- The pack currently has only one configured character. A player-specific skin needs a
  server-validated, replicated `characterId`; it must not be chosen locally from an arbitrary
  URL. The current default is deliberately hard-coded at the composition root.
- The old procedural body had four directional death variants. This supplied pack has only
  stand/crouch deaths, so the GLB path deliberately retains posture but not that visual variant
  until matching authored clips exist.

The catalog temporarily records a reviewed legacy `last` selector plus expected duration. That
is an adapter for the current files, not a file-format convention to extend.

## Required export contract

Before adding more skins, export each animation as an animation-only GLB containing exactly one
named semantic clip, for example `walk_relaxed`. Update `CharacterCatalog` to use the `name`
selector. Every skin must satisfy its `CharacterRigProfile`:

- the required named bones and compatible bind/rest pose;
- an explicit weapon hand/socket and calibrated transform;
- scale/orientation checked against `HUMANOID_RIG`;
- in-place locomotion (or a documented root-motion policy);
- texture/mesh budgets suitable for the target GPU.

Use KTX2/Basis texture compression, reduced texture resolution, mesh compression, versioned
asset URLs, and Git LFS or a CDN for production delivery. Load the bundle during a loading/warmup
phase; `BotRenderer` keeps the procedural body only as a non-blocking fallback while that work
is in flight or fails. It creates or upgrades at most two GLB avatars per render frame so a ready
template cannot synchronously replace an entire roster. This amortizes cloning, but it does not
make the current 117.56 MiB download/parse acceptable: optimizing the source pack and moving
preload before gameplay are release requirements.

The catalog version is part of both the repository cache key and the public asset query string.
Bump it whenever an exported file changes. This is a simple browser-cache guard; a content-hashed
CDN manifest remains the stronger production solution. A failed load intentionally falls back for
the current match rather than retrying from the render loop. Add bounded retries to a loading
phase if product requirements call for recovery from a transient network failure.

## Animation policy

`AnimationSelector` maps semantic state to semantic clip IDs; it has no file paths or Three.js
objects. A clip that does not exist must fall back to a known locomotion pose. Do not introduce
type checks such as `actor instanceof Bot`: both local bots and remote players satisfy the same
`RenderableActor` contract.

The supplied `Idle_Relaxed` and `Walk_Relaxed` clips are not firearm-holding poses. Until
dedicated hip-ready exports arrive, the catalog names the reviewed armed clips
`idleWeaponReady`/`walkWeaponReady` even though their source filenames say `Aiming`; the
selector chooses them for a body that actually carries a weapon. The weapon mesh supplies its
own trigger-grip anchor, while the rig catalog supplies only the hand-axis calibration. This
keeps weapon-class geometry and character-rig alignment independent.

`AnimationMixer` and `AnimationAction` are per avatar. Parsed clips, source geometry, and source
textures are shared. Materials are cloned per avatar because a team tint must never repaint a
different actor using the same template. Team appearance is resolved relative to the local
viewer, so the enemy is consistently hostile/red from either A or B; it is not an absolute
"team A/team B" colour.

The third-person weapon uses two semantic anchors from the weapon layout: `triggerHandAnchor`
attaches the mesh to the animated right hand, and `supportHandAnchor` marks its physical support
grip. `WeaponSupportHandConstraint` runs after the mixer only for weapon-ready clips and rotates
the cloned left upper arm/forearm until a rig-specific virtual palm marker meets that support
grip. It is deliberately a visual constraint: it cannot move the authoritative actor transform,
does not run during deaths or relaxed sprint clips, and does not alter shared skeleton templates.
