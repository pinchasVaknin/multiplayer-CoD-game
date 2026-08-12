/**
 * The §8.25 cosmetic audit, as a check that can fail (M11 Gate B).
 *
 * §8.25: *"Cosmetic audit: no decal, tracer, particle or viewmodel state appears in any
 * snapshot."* §4.15 draws the line it is auditing:
 *
 *   Server-authoritative (replicated) | Client-only (never replicated)
 *   position, velocity, stance, aim   | tracers, muzzle flash, impact decals
 *   health, damage, death, hitreg     | particles, blood, shell ejection
 *   ammo, reload, equipped weapon     | viewmodel animation, camera shake, bob
 *   objective, scores, round state    | screen effects, vignette, tinnitus
 *   killstreak earn/activation/entity | crosshair, hitmarker, HUD
 *
 * ## Why this is an allowlist rather than a banned-word search
 *
 * A banned-word search only catches a cosmetic somebody was honest enough to name `decal`. The
 * failure that actually happens is a field called `impactX` or `shakeAmount` or `serial` that
 * nobody notices is presentation, and no keyword list anticipates it.
 *
 * So the snapshot's field set is **pinned**. Adding a field to `EntitySnapshot` fails this check
 * until it is listed below with a reason, which makes "is this gameplay or is this presentation"
 * a question somebody has to answer out loud rather than one that can be skipped by accident.
 * That is the whole mechanism, and it is the same one `check-boundaries` uses: a rule a human
 * has to remember is a rule that will be broken.
 */

import { readFileSync } from 'node:fs';

const SNAPSHOT = 'src/shared/net/Snapshot.ts';

/**
 * Every field the entity snapshot is allowed to carry, and why it is gameplay rather than
 * presentation. Keyed by field name; the value is the §4.15 row it sits in.
 */
const ALLOWED = {
  entityId: 'identity — every other field is meaningless without it',
  displayName: 'identity; the killfeed and scoreboard resolve names from the snapshot',
  x: '§4.15 position',
  y: '§4.15 position',
  z: '§4.15 position',
  yaw: '§4.15 aim angles',
  pitch: '§4.15 aim angles',
  vx: '§4.15 velocity',
  vz: '§4.15 velocity',
  stance: '§4.15 stance',
  heightScale: 'the collision capsule height stance implies — a hitbox fact, not a pose',
  health: '§4.15 health',
  weaponIndex: '§4.15 equipped weapon',
  flags: 'alive/firing/reloading/ads/sprinting/grounded/bot/team — all §4.15 gameplay state',

  /**
   * The four visual serials, and the one deliberate judgement call in this file.
   *
   * They are **not** particle state: no position, no lifetime, no count, no material. A serial
   * is a monotonic counter meaning "this entity died / spawned / flinched for the Nth time", and
   * an angle meaning "facing this way when it happened" — which is a gameplay fact (where the
   * round came from), not a decision about what it looks like. The client owns the ragdoll, the
   * blood, the camera kick and the sound; it is told only *that it happened*.
   *
   * They ride the snapshot rather than the event channel on purpose, and it is worth being
   * explicit about the trade: an event can be dropped, and a dropped death event leaves a body
   * standing for ever. A serial is idempotent — a client that missed three snapshots sees the
   * counter jump and plays one death, which is exactly right. That is §4.15's "cosmetics are
   * driven by replicated events" honoured in substance, with the delivery guarantee an event
   * channel does not have.
   */
  deathSerial: 'event-as-counter; see the note above',
  deathAngle: 'the direction the killing round travelled — a gameplay fact',
  spawnSerial: 'event-as-counter; see the note above',
  flinchSerial: 'event-as-counter; see the note above',
  flinchAngle: 'the direction the hit came from — a gameplay fact',
};

function fail(lines) {
  console.error('cosmetic audit FAILED (§8.25):');
  for (const line of lines) console.error(`  - ${line}`);
  process.exit(1);
}

const src = readFileSync(SNAPSHOT, 'utf8');
const start = src.indexOf('export interface EntitySnapshot {');
if (start < 0) {
  fail([`could not find EntitySnapshot in ${SNAPSHOT} — this check has stopped checking`]);
}
const end = src.indexOf('\n}', start);
const body = src.slice(start, end);

// `name: type;` at one level of indentation. Comments and blank lines fall out naturally.
const found = [...body.matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)].map((m) => m[1]);

const problems = [];
for (const field of found) {
  if (!(field in ALLOWED)) {
    problems.push(
      `EntitySnapshot.${field} is serialised into every snapshot and is not in the §4.15 ` +
        'allowlist. If it is gameplay state, add it to scripts/check-cosmetics.mjs with the ' +
        'row of §4.15 it belongs to. If it is presentation, it must be driven by a replicated ' +
        'event instead — see the table at the top of that file.',
    );
  }
}

// The reverse direction: an allowlist entry with no field is a rule guarding nothing, which is
// how this check quietly stops covering the thing it was written for.
for (const field of Object.keys(ALLOWED)) {
  if (!found.includes(field)) {
    problems.push(
      `the allowlist names EntitySnapshot.${field}, which no longer exists. Remove it, so the ` +
        'list keeps describing the code rather than its history.',
    );
  }
}

if (problems.length > 0) fail(problems);

console.log(
  `cosmetic audit ok — ${found.length} snapshot fields, all §4.15 gameplay state ` +
    '(no decal, tracer, particle or viewmodel).',
);
