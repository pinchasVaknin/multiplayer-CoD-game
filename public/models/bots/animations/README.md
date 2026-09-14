# The animation library

Every skinned body in the game — bots and remote players alike — is drawn with the clips in
this folder. Nothing here is discovered at runtime: a file is used only once
`src/client/characters/CharacterCatalog.ts` names it in a **slot**, and `npm run
check:animations` refuses a file nobody catalogued, a catalogue entry nobody shipped, and a
slot the selector could ask for and find empty. A slot is a pose the game asks for
(`crouchIdleAiming`, `deathStand`, …); it can hold several clips — **variants** — and which one
a body wears is dealt from facts every client shares (`AnimationVariant.ts`), never at random.

## Folders

| Folder | What goes in it | Slots |
|---|---|---|
| `locomotion/stand/` | standing loops: idle, walk, run and sprint, relaxed and weapon-ready | `idleRelaxed`, `idleWeaponReady`, `walkRelaxed`, `walkWeaponReady`, `runRelaxed` |
| `locomotion/crouch/` | the kneel and the crouched walk and run. The hitbox rig wears a layout per crouch loop (`HUMANOID_CROUCH_*_RIG`), so a new loop here is measured with `scripts/measure-crouch.mjs --pose` before it is admitted | `crouchIdleAiming`, `crouchWalkAiming`, `crouchRunAiming` |
| `locomotion/slide/` | a slide loop, when one is authored. Until then a slide draws the crouch loops and wears their layouts | — |
| `transitions/` | one-shots between stances, named `Transition_<From>_To_<To>` | `crouchToStand`, `standToCrouch` |
| `actions/` | one-shots the body does while otherwise standing still or walking: reloads today; throws and melee once their snapshot bits exist | `reloadStand`, `reloadWalk`, `reloadCrouch` |
| `deaths/` | falls. Variants are indexed by the simulation's `deathVariant`, so `DEATH_VARIANTS` (`shared/ai/BotVisualState.ts`) must be a multiple of each death slot's count | `deathStand`, `deathCrouch` |
| `hits/` | flinch clips, when authored; dealt per `(entityId, flinchSerial)` | — |
| `incoming/` | **dropped here, never loaded.** Where a new export waits to be read and sorted | — |

## Adding a clip

1. Drop the export in `incoming/`.
2. `node scripts/animation-manifest.mjs incoming` — what is actually in the file: how many
   clips, their names and lengths, which bones they animate, which of those bones the skins
   lack, and the hips' height through the clip (a kneel is ~0.42 m, the half-squat family
   ~0.49, standing ~0.9). Decide the slot from that, not from the file name.
3. For a crouch loop, `node scripts/measure-crouch.mjs --pose` — the crown against the layout
   the rig wears for that slot. A delta past the layout's padding means the layout moves with
   the clip, or the clip does not go in.
4. `node scripts/animation-import.mjs incoming/<File>.glb <folder>` — writes
   `<folder>/<File>.glb` with exactly one clip, named `<File>`, and removes the source. This
   is the **export contract**: one named clip per file. A Blender/Mixamo session export
   carries every clip of the session and only the last is the one wanted; the tool keeps that
   one, byte for byte, and drops the rest.
5. Add it to the slot in `CharacterCatalog.ts` with `named('<folder>/<File>')`, bump
   `CHARACTER_VERSION`, and run `npm run check`.

The eleven original files are still session exports read by the legacy "last clip" rule
(`legacy(path, expectedDuration)` in the catalogue); `check:animations` counts how many are
left. Passing them through `animation-import.mjs` makes them contract files with identical
track data at roughly a fifth of the size.

## Skeletons

The skins are 65-bone Mixamo rigs (Apex and Pulse 67 with eye bones, Sentry 69 with `Neck1`
and `Jaw`). The original files were exported on the 65-bone skeleton; the newer ones on a
69-bone one whose `mixamorigNeck1` six of the seven skins lack, so on those skins the head
lands 3–4 cm lower than authored (measured in PLAN.md, M13 C1 and D). `importClip` drops a
track for a bone the skin does not have; nothing is retargeted. Export on the 65-bone skeleton
when you can.
