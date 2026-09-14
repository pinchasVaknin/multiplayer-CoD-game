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
 *
 * Since M13 Phase B the scoreboard row (`ReplicatedScoreRow`, carried whole by
 * `MsgS.Scoreboard`) is pinned the same way, under the same table's "scores" row.
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
  heightScale: 'the collision capsule height stance implies — a hitbox fact, not a pose (redundant with stance since M13 C2; leaves with v13)',
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

/**
 * The scoreboard row, pinned the same way (M13 Phase B).
 *
 * `MsgS.Scoreboard` carries the server's rows whole, twenty-four of them at most, to every
 * seat — a second serialised record beside the snapshot, and the §4.15 row it sits in is
 * "objective, scores, round state". Every field is a tally the server made; nothing here is a
 * colour, a highlight or a sort order, which are the client's.
 */
const SCORE_ROW = 'src/shared/combat/ScoreSystem.ts';
const ALLOWED_SCORE_ROW = {
  entityId: 'identity — the row is keyed by it',
  displayName: 'identity; the board draws the name the server holds',
  team: '§4.15 scores — which side the tally counts toward',
  kills: '§4.15 scores',
  deaths: '§4.15 scores',
  assists: '§4.15 scores',
  score: '§4.15 scores — the mode-defined points',
  streak: '§4.15 scores — consecutive kills, the killstreak economy reads it',
  bestStreak: '§4.15 scores',
  shotsFired: '§4.15 scores — the accuracy column, counted on the server since round 5 B5',
  shotsHit: '§4.15 scores — the other half of the accuracy column',
  damageDealt: '§4.15 scores',
  headshots: '§4.15 scores',
  captures: '§4.15 objective — Domination',
  defends: '§4.15 objective — Domination',
  plants: '§4.15 objective — Search & Destroy',
  defuses: '§4.15 objective — Search & Destroy',
  tags: '§4.15 objective — Kill Confirmed',
};

function fail(lines) {
  console.error('cosmetic audit FAILED (§8.25):');
  for (const line of lines) console.error(`  - ${line}`);
  process.exit(1);
}

/** The fields declared on one interface in one file, pinned against one allowlist. */
function auditInterface(file, name, allowed, describe) {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf(`export interface ${name} {`);
  if (start < 0) {
    fail([`could not find ${name} in ${file} — this check has stopped checking`]);
  }
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);

  // `name: type;` at one level of indentation, `readonly` or not. Comments and blank lines
  // fall out naturally.
  const found = [...body.matchAll(/^\s{2}(?:readonly\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\??\s*:/gm)].map(
    (m) => m[1],
  );

  const problems = [];
  for (const field of found) {
    if (!(field in allowed)) {
      problems.push(
        `${name}.${field} is serialised ${describe} and is not in the §4.15 ` +
          'allowlist. If it is gameplay state, add it to scripts/check-cosmetics.mjs with the ' +
          'row of §4.15 it belongs to. If it is presentation, it must be driven by a replicated ' +
          'event instead — see the table at the top of that file.',
      );
    }
  }

  // The reverse direction: an allowlist entry with no field is a rule guarding nothing, which is
  // how this check quietly stops covering the thing it was written for.
  for (const field of Object.keys(allowed)) {
    if (!found.includes(field)) {
      problems.push(
        `the allowlist names ${name}.${field}, which no longer exists. Remove it, so the ` +
          'list keeps describing the code rather than its history.',
      );
    }
  }
  return { found, problems };
}

const snapshot = auditInterface(SNAPSHOT, 'EntitySnapshot', ALLOWED, 'into every snapshot');
const scoreRow = auditInterface(SCORE_ROW, 'ReplicatedScoreRow', ALLOWED_SCORE_ROW, 'into every scoreboard');
const problems = [...snapshot.problems, ...scoreRow.problems];

if (problems.length > 0) fail(problems);

console.log(
  `cosmetic audit ok — ${snapshot.found.length} snapshot fields and ${scoreRow.found.length} ` +
    'scoreboard-row fields, all §4.15 gameplay state (no decal, tracer, particle or viewmodel).',
);
