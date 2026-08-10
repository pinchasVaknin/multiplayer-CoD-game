# M10 Fixes Handover — extracted from M11 before the Skirmish/Warmup rewrite

**Purpose.** M11's Matchmaking / Bucket / Queue systems are being discarded by rolling the
workspace back to `m10-complete`. This document carries forward every bug fix made during M11
that belongs to the **M10 foundation** — netcode, sync, prediction, disconnects, UI, bots, and
the simulation — so none of them are lost with the architecture they happened to be written in.

**Extraction range.** `m10-complete` (`afe7399`) → `HEAD` (`80d6957`), plus the uncommitted
working tree (Phase 3).

**Excluded as matchmaking-only** (dies with the rollback, deliberately not carried forward):
`src/server/master/*`, `src/server/instance/*`, `src/client/ui/Lobby.ts`,
`src/client/net/MasterSession.ts`, `src/shared/net/Matchmaking.ts`, `src/server/mmHarness.ts`,
`src/server/leakHarness.ts`, `src/server/debug/MatchmakingClient.ts`.

> Line numbers below are anchors **at `m10-complete`**. They will drift as you apply fixes —
> use the surrounding code as the real anchor.

---

## Contents

- [Read this first — three corrections](#read-this-first--three-corrections)
- [Recommended order of application](#recommended-order-of-application)
- [Tier 1 — direct ports (21 fixes)](#tier-1--direct-ports)
  - [Server sim](#server-sim) — [1](#1-ffa-friendly-fire) · [2](#2-bots-ignore-the-pre-match-freeze) · [3](#3-rewind-absolute-vs-relative-ticks) · [11](#11-smallerteam-put-every-human-on-team-a) · [12](#12-removed-bots-kept-writing-rig-history) · [13](#13-bot-ids-could-be-reused) · [20](#20-lightweight--permanent-misprediction)
  - [Server net](#server-net) — [9](#9-ungraceful-disconnect-never-fired-onleave) · [21](#21-wsservermaxconnectionsperip)
  - [Shared](#shared) — [7a](#7a-entityinterpolatorsnapto) · [17](#17-netclientsawmatchover-latch) · [18](#18-eventbussubscriptioncount) · [19](#19-two-match-clocks)
  - [Client](#client) — [4](#4-weapon-swap-model-never-updated) · [5](#5-sd-alive-counter) · [6](#6-respawned-bodies-stuck-in-the-dead-pose) · [7b](#7b-remoteactor--snap-before-sampling) · [8](#8-respawn-timer-frozen-at-45) · [10](#10-handshake-dropped-frames-behind-identity) · [14](#14-ffa-banner-showed-a-vs-b) · [15](#15-domination-flag-colours-backwards-for-team-b) · [16](#16-thermalgunship-pass-drew-own-side-hot)
- [Tier 2 — needs translation](#tier-2--needs-translation)
- [Tier 3 — already in M10, do NOT re-apply](#tier-3--already-in-m10-do-not-re-apply)
- [Standing lessons worth keeping](#standing-lessons-worth-keeping)

---

## Read this first — three corrections

Three items from the original extraction brief need adjusting. Acting on the brief as written
would waste effort or cause conflicts.

### ❌ "Frozen after respawn" is **already in M10**

The fix (`applyReplicatedSelf`, `respawnNetworked`, `netFrozen`, `metresSinceRespawn`) is commit
`a2d1fec`, which is **before** the `m10-complete` tag. It survives the rollback. **Do not
re-apply it.** The similarly-named M11 fix is the respawn *timer display* — a different bug,
carried below as [#8](#8-respawn-timer-frozen-at-45).

### ⚠️ The `replaceChildren()` bug has **no portable code**

The only fixed site was `src/client/ui/Lobby.ts`, an M11-only file that dies in the rollback.
M10's other `replaceChildren` calls are open-once menus and are not buggy. What survives is the
*discipline* plus a reusable template — see [Tier 2 §B](#b-the-replacechildren-discipline--template).

### ⚠️ The match-end race does **not** manifest at M10

M10's `GameServer.tick` keeps ticking after `match.isOver` (endHold → rotate), so the phase
always reaches a snapshot tick. The bug was `MatchInstance` **stopping** the stepping. It is a
forward-looking guard for the new Skirmish flow — see
[Tier 2 §A](#a-match-end-race--the-guard-restated-for-a-new-flow).

---

## Recommended order of application

Later groups depend on earlier ones compiling. Within a group, order does not matter.

| # | Group | Fixes | Note |
|---|---|---|---|
| 1 | **Server sim** | 1, 2, 3, 11, 12, 13, 20 | Do #2 **last** in this group — it moves the harness baseline. |
| 2 | **Re-record baseline** | — | Isolate #2 (`git stash` the rest), re-run `npm run harness`, record the new numbers deliberately. |
| 3 | **Server net** | 9, 21 | Then Tier 2 §C and §D as the Skirmish flow takes shape. |
| 4 | **Shared** | 7a, 17, 18, 19 | `snapTo` must land before the client half of #7. |
| 5 | **Client** | 4, 5, 6, 7b, 8, 10, 14, 15, 16 | |
| 6 | **Verify** | — | `npm run check`, `npm run harness`, then the playtest list at the end. |

---

## Tier 1 — direct ports

### Server sim

---

#### 1. FFA friendly fire

**File:** `src/server/Match.ts` (anchor: line 173, in the `ServerMatch` constructor)

`ServerMatch` set `bots.freeForAll` but never `damage.friendlyFire` — which `ClientMatch` has set
since M7. Free-for-All keeps the two-team substrate internally, so half the roster was rendered
hostile, hunted by the AI, and **immune**: `DamageSystem.apply` returned 0 for every shot at them
and `Ballistics` skipped their rigs entirely, so rounds passed straight through.

Read off the registry rather than compared against the id — that is what the client does, and it
is the difference between one fact and two.

```ts
// BEFORE
this.bots.freeForAll = this.modeEntry.id === 'FFA';
```

```ts
// AFTER
this.bots.freeForAll = this.modeEntry.freeForAll === true;
if (this.modeEntry.freeForAll === true) this.damage.friendlyFire = true;
```

> `ModeEntry.freeForAll` already exists at M10 (`src/shared/modes/ModeRegistry.ts:68`), so this
> applies cleanly with no registry change.

---

#### 2. Bots ignore the pre-match freeze

**File:** `src/server/Match.ts` (in `step()`, immediately before `this.bots.simulate(...)`)

`stepPlayer` has passed `inputFrozen` since M10 and the bots never received it. During WARMUP and
ROUND_END the humans stood still and the bots played on — sprinting off their spawns and, in
Search & Destroy, starting the round before the round started.

The mechanism already existed and the server simply never set it. `ClientMatch` has assigned
`bots.inputFrozen` since M7, and `Bot.advance` neuters the movement axes and the trigger before
the command reaches the controller — while still letting the bot **perceive**, so that when the
round goes live it acts on a world it has been watching rather than waking up blind.

```ts
// INSERT immediately above the existing bots.simulate call
this.bots.inputFrozen = this.inputFrozen;
this.bots.simulate(tickIndex, tickIndex * DT * 1000);
```

> ### ⚠️ This changes the harness baseline — do not "fix" the mismatch
>
> The bot freeze alters the server sim from tick 180 onward. This is a **deliberate** baseline
> change bringing the server into parity with the client. M11's post-fix record was
> `A wins 75-53` in `16144` ticks, RECRUIT hit rate `0.066`, 5/5 completed (superseding
> `75-46 / 13705 / 0.079`).
>
> **Your M10 numbers will differ from both.** Isolate this change (`git stash` everything else),
> re-run, and record the new baseline explicitly. A baseline change must never be absorbed
> silently.
>
> **Do not** instead skip `simulate()` entirely — a first attempt did, and it also skipped
> perception. The parity port is correct; skipping is not.

---

#### 3. Rewind absolute vs relative ticks

**File:** `src/server/Match.ts` (anchor: line 478, in `spawnPlayer`)

`Rewind.record` is called from `step` with the **absolute** tick, and `RigHistory` validates a
slot by storing the tick that wrote it. A history stamped with a match-relative index is a
history whose every slot fails its own validity check.

The symptom is lag compensation quietly declining to apply — `rec.missed` on every entity, every
shot resolving against the present — which players report as *"shots stopped registering"* and
which reads as a netcode fault rather than an off-by-a-few-hundred-thousand in an array index.

**Add the field and the option:**

```ts
// ServerMatchOptions — ADD
/**
 * The master's absolute tick at construction. Defaults to 0 for the harnesses.
 *
 * The match does not use it as a clock. It exists so everything indexed by absolute tick is
 * stamped correctly **before the first `step`** — players seated during LOADING spawn then, so
 * their rig history is written before `step` has had a chance to say what tick it is.
 */
readonly startTick?: number;
```

```ts
// ServerMatch — ADD field, next to `private ticks = 0;`
/**
 * The **absolute** tick this match was last stepped on.
 *
 * Distinct from `ticks`, which counts steps this match has taken. At M10 the one match was
 * created at tick 0 and stepped every tick thereafter, so the two were equal forever and
 * nothing could tell them apart. A flow that creates a match part-way through process uptime
 * makes them disagree permanently, and `Rewind` is indexed by the absolute one.
 */
private currentTick = 0;
```

```ts
// Constructor — FIRST line of the body
this.currentTick = options.startTick ?? 0;
```

```ts
// step() — FIRST line of the body
step(tickIndex: number): void {
  this.currentTick = tickIndex;
  this.outgoing.begin();
  // ...
}
```

**Then the actual fix:**

```ts
// BEFORE (in spawnPlayer)
this.rewind.resetAt(player.entityId, this.ticks);
```

```ts
// AFTER
this.rewind.resetAt(player.entityId, this.currentTick);
```

> **Latent at M10, live the moment you change one thing.** `GameServer` builds its one match at
> tick 0, so `ticks` and the absolute tick are equal and this reads correctly by coincidence. The
> coincidence ends the instant your Skirmish flow constructs a match at a non-zero server tick.
> Port it now — it is free, and invisible until it isn't.

---

#### 11. `smallerTeam` put every human on team A

**File:** `src/server/Match.ts` (in `smallerTeam()`)

The original counted the whole roster and broke ties toward A — correct arithmetic, wrong
question. A seat is granted and then a bot is removed *from the same side*, restoring the body
count to what it was, so the next joiner finds the identical tie and is sent to A as well.

Measured on a four-human TDM backfill: entities 1, 2, 3 and 4 all on team A, playing four bots.
The teams were the size the mode asked for and every human was on one of them.

Invisible with one human in the match — one human is on a balanced team by definition.

```ts
// BEFORE
/** Side with fewer participants, counting bots. Ties go to A. */
private smallerTeam(): BotTeam {
  let a = 0;
  let b = 0;
  for (const c of this.bots.roster) {
    // ...existing body count...
  }
  // ...
}
```

```ts
// AFTER
/**
 * Which side a joining human goes on: **fewer humans first**, then fewer bodies.
 *
 * Bots are interchangeable; humans are the thing a player notices being on the wrong side of.
 */
private smallerTeam(): BotTeam {
  let humansA = 0;
  let humansB = 0;
  for (const p of this.players) {
    if (p.team === 'A') humansA++;
    else humansB++;
  }
  if (humansA !== humansB) return humansA < humansB ? 'A' : 'B';

  // ...existing body-count tie-break, unchanged, below this point...
  let a = 0;
  let b = 0;
  for (const c of this.bots.roster) {
    // ...
  }
  // ...
}
```

---

#### 12. Removed bots kept writing rig history

**File:** `src/server/Match.ts` (new method on `ServerMatch`)

`BotDirector.removeOne` releases everything a bot holds **in `shared/`** — roster slot, id map,
`DamageSystem` registration, cover reservation. It cannot release the one thing the bot holds in
`server/`, its `Rewind` history, because `BotDirector` lives in `shared/` and `Rewind` is a
server-only structure `shared/` is forbidden to import.

This is **not** a hit-registration bug, and the distinction matters: `DamageSystem` no longer
holds the bot, so no ray can resolve against it. What survives is a phantom in the
lag-compensation path — `Rewind.record` writes its frozen pose every tick forever, and every
subsequent `begin` saves, rewinds and restores a rig nobody can shoot, inflating `moved` and
`missed`. It quietly corrupts the instrument rather than the game.

```ts
// ADD to ServerMatch
/**
 * Take a bot off the roster to make room for a human.
 *
 * Not just `bots.removeOne`: the director cannot unregister from `Rewind` (server-only), so
 * `populate()` registered the bot here and nothing ever unregistered it.
 */
removeBotForSeat(team: BotTeam): boolean {
  const bot = this.bots.removeOne(team);
  if (bot === null) return false;
  this.rewind.unregister(bot.entityId);
  return true;
}
```

> **Route all bot removal through this**, never `bots.removeOne` directly. Latent at M10 (the only
> caller was match start, costing ten dead entries per match); a Skirmish flow that swaps bots for
> arriving players calls it repeatedly, mid-match, for the whole life of the match.

---

#### 13. Bot ids could be reused

**File:** `src/shared/ai/BotDirector.ts`

Deriving the next bot index from `bots.length` hands a new bot an id somebody is still using —
inheriting another body's rig history, its cover reservation, and on every client its mesh and
its interpolation buffer. `bots.length` *falls* when `removeOne` takes a bot off for a joining
human, which is exactly when a replacement is minted.

```ts
// ADD near BOT_ID_BASE
/**
 * How many bots one match may ever create, including mid-match replacements.
 *
 * Entity ids go on the wire as a byte and 255 is the `NO_ENTITY` sentinel, so ids must stay
 * under it. `BOT_ID_BASE + 150` is 250, which leaves the sentinel alone and is an order of
 * magnitude past what a real match reaches. `addOne` refuses past it rather than wrapping,
 * because a wrapped id is a body that inherits another's rig history and, on every client,
 * its mesh.
 */
const MAX_BOT_INDEX = 150;
```

```ts
// ADD field to BotDirector
/**
 * The next bot index to mint. Monotonic within a match; reset only by `populate`.
 *
 * Deliberately **not** derived from `bots.length`, which falls when `removeOne` takes a bot off
 * for a joining human — deriving from it would hand the next bot an id somebody is still using.
 */
private nextIndex = 0;
```

```ts
// populate() — replace the local `let index = 0` with the field
populate(teamA: number, teamB: number, tierMix: readonly BotTier[]): void {
  this.clear();
  this.nextIndex = 0;
  const add = (team: BotTeam, count: number): void => {
    for (let i = 0; i < count; i++) {
      const tier = tierMix[this.nextIndex % Math.max(tierMix.length, 1)] ?? 'REGULAR';
      this.createBot(team, tier);   // extracted from the old inline body; increments nextIndex
    }
  };
  add('A', teamA);
  add('B', teamB);
}
```

```ts
// ADD — the inverse of removeOne, for a player leaving mid-match
addOne(team: BotTeam, tier: BotTier): Bot | null {
  if (this.nextIndex >= MAX_BOT_INDEX) return null;
  return this.createBot(team, tier);
}
```

Extract the per-bot construction from `populate` into a private `createBot(team, tier)` that mints
`BOT_ID_BASE + this.nextIndex`, pushes to `bots`/`roster`/`byId`, registers with `DamageSystem`,
spawns, and increments `nextIndex`.

**Server-side companion** (needed if a leaver should be replaced rather than leaving a side a body
down — in S&D, where `anyAlive` decides the round and one life means nobody comes back, the last
human on a team disconnecting **ends the round for everybody**, scored as an elimination nobody
achieved):

```ts
// src/server/Match.ts — ADD
replacePlayerWithBot(entityId: number): boolean {
  const player = this.getPlayer(entityId);
  if (player === undefined) return false;
  const team = player.team;
  this.removePlayer(entityId);

  const mix: readonly BotTier[] = this.mapEntry.tierMix;
  const tier = mix[this.bots.bots.length % Math.max(mix.length, 1)] ?? 'REGULAR';
  const bot = this.bots.addOne(team, tier);
  if (bot === null) {
    log.warn(`no bot could replace entity ${entityId} on team ${team} — the side is a body down.`);
    return false;
  }
  this.score.register(bot.entityId, bot.displayName, bot.team);
  // Bots are rewound too — a hole here is a shot that silently resolves against the present.
  this.rewind.register(bot);
  this.rewind.resetAt(bot.entityId, this.currentTick);
  log.info(`entity ${entityId} left; ${bot.displayName} took over on team ${team}.`);
  return true;
}
```

The replacement spawns fresh rather than inheriting the body — a bot taking over a corpse
mid-round would be a body that died and is now alive with no spawn serial, which every client
renders as a corpse standing up.

---

#### 20. Lightweight = permanent misprediction

**Files:** `src/server/NetPlayer.ts`, `src/server/Match.ts`

`MatchMeta.applyPerkHooks` sets `player.speedScale` from the equipped class on **every** client
with no networked guard, and that controller is the one `NetClient` predicts with. The server had
no loadout and left it at 1. The shipped ASSAULT class carries Lightweight at +7%.

So the default class over the network predicted **7% faster than the server simulated, on every
tick, forever** — a correction stream that reads as jitter and is arithmetic.

Prediction requires `PlayerController.step` to be a pure function of (state, command) **across both
runtimes**. A perk the server has not been told about is not a perk; it is a permanent
misprediction.

**Measured:** `407/559` and `279/557` mispredictions for the two shipped classes carrying
Lightweight, against `6/558` for the one without it in the same run. With the loadout crossing the
wire: `0/557`, `0/557`, `0/519`.

```ts
// src/server/NetPlayer.ts — ADD to NetPlayerDeps
/** The resolved perks this player is carrying. `NO_PERKS` for anything without a loadout. */
readonly perks: PerkState;
```

```ts
// src/server/NetPlayer.ts — ADD at the end of the constructor
/**
 * Lightweight, on the authoritative side.
 *
 * The same assignment `MatchMeta.applyPerkHooks` makes on the client, and it has to be the
 * same or `PlayerController.step` stops being a pure function of (state, command) across the
 * two runtimes — which is the property reconciliation depends on.
 */
this.controller.speedScale = deps.perks.moveSpeedMult;

// ADD accessor
/** The perks this player is carrying. Read by bot perception and the streak system. */
get perks(): PerkState {
  return this.deps.perks;
}
```

```ts
// src/server/Match.ts — ADD field
/**
 * Each seated human's resolved class, by entity id.
 *
 * Kept alongside the player rather than on it because the consumers take a *predicate over an
 * entity id* — and those are asked about bots too, which have no loadout.
 */
private readonly loadouts = new Map<number, ResolvedLoadout | null>();
```

```ts
// src/server/Match.ts — addPlayer
// BEFORE
addPlayer(displayName: string): NetPlayer | null {
  // ...
  const player = new NetPlayer(entityId, displayName, team, {
    // ...
    // The default loadout. This milestone is "two people shooting at each other correctly".
    weaponDef: AR_DEFAULT,
    secondaryDef: PISTOL_DEFAULT,
  });
```

```ts
// AFTER
addPlayer(displayName: string, loadout?: LoadoutSlot | null): NetPlayer | null {
  // ...
  /**
   * The *same* shared `resolveLoadout` the loadout editor calls per keystroke, so the weapon
   * this player holds on the server is built from the identical base def, attachment chain and
   * perk modifiers as the one they are looking down.
   *
   * Absent — any client that has not sent one yet — it falls back to the M10 pair, so nothing
   * that worked before changes.
   */
  const resolved = loadout == null ? null : resolveLoadout(loadout, 0);

  const player = new NetPlayer(entityId, displayName, team, {
    // ...
    weaponDef: resolved?.primary ?? AR_DEFAULT,
    secondaryDef: resolved?.secondary ?? PISTOL_DEFAULT,
    perks: resolved?.perkState ?? NO_PERKS,
  });
  this.loadouts.set(entityId, resolved);
```

```ts
// src/server/Match.ts — ADD lookups
/**
 * The perks an entity is carrying. `NO_PERKS` for bots and for anyone without a loadout.
 *
 * Bots deliberately get the neutral state rather than a special case: "a bot has no loadout"
 * is already what `NO_PERKS` means.
 */
perksOf(entityId: number): PerkState {
  return this.loadouts.get(entityId)?.perkState ?? NO_PERKS;
}

/** The resolved class an entity brought, or null. */
loadoutOf(entityId: number): ResolvedLoadout | null {
  return this.loadouts.get(entityId) ?? null;
}
```

```ts
// src/server/Match.ts — in removePlayer, alongside the other unregisters
this.loadouts.delete(entityId);
```

```ts
// src/server/Match.ts — in the constructor: Dead Silence, server-side.
// The client half has existed since M6 and decided nothing over the network, because the bots
// that hear the footsteps live here and this hook was never set.
this.bots.silentFootsteps = (entityId) => !this.perksOf(entityId).audibleFootsteps;
```

**Recommended log line** — the class is now a thing that can be wrong, and *"what did the server
think this player brought"* is the first question when a duel looks wrong:

```ts
const perks = describePerkState(this.perksOf(entityId));
log.info(
  `${displayName} seated as entity ${entityId} on team ${team} — ` +
    `${player.weapons.definition.id}/${resolved?.secondary.id ?? PISTOL_DEFAULT.id}, perks ${perks}` +
    (resolved === null ? ' (no loadout sent; server defaults)' : ''),
);
```

> ### ⚠️ This fix has a transport dependency the rollback deletes
>
> M11 carried the class over `MsgC.Loadout`, a master-scoped message. **Your Skirmish flow needs
> some path for the client's class to reach the server before `addPlayer`, or the divergence
> returns.** Three rules that survive the rewrite:
>
> 1. **Send ids, not resolved numbers.** Resolve server-side with the same shared
>    `resolveLoadout`, so a def-table reorder cannot silently change meaning.
> 2. **Validate at the boundary and never throw.** `sanitiseNetLoadout` checks that ids are
>    *real*. It deliberately cannot check *unlocks* — the server has no profile, and progression
>    is client-side. A player can therefore field a weapon they have not unlocked; that is a
>    known, recorded gap, not a bug to discover again.
> 3. **Defer mid-match class changes.** Applying a class change live to a standing networked
>    world reintroduced the same divergence by another door. Deferring to next spawn is CoD
>    behaviour anyway.

---

### Server net

---

#### 9. Ungraceful disconnect never fired `onLeave`

**File:** `src/server/net/Session.ts` (anchor: line 136, in `checkTimeout()`)

**The single highest-value fix in this document for a Skirmish/Warmup flow.**

The guard was `if (this.closed) return`, and `closed` is true when **either** this session or its
link has gone. So a connection that dropped abruptly returned immediately, `close()` was never
reached, and `host.onLeave` was never called. Every consequence of a disconnect was skipped:

- The reconnect grace **never held a seat** — for the one kind of disconnect it exists to cover.
  A returning player presented a perfectly good token, the server found no seat behind it, and
  issued a fresh identity. Measured: a client that dropped as session 1 came back as session 4.
- The match kept a dead session in its seat list and kept addressing snapshots to it for the rest
  of the match.
- A player who dropped while waiting stayed counted as present.

The clean disconnect never had the problem, because a `Bye` goes through `close()` on the way in.
**That is why it survived M10 and Gate A: both tested the path that works.**

```ts
// BEFORE
checkTimeout(): void {
  if (this.closed) return;

  const now = nowMs();
  if (this.state === 'handshaking' && now - this.openedMs > HANDSHAKE_TIMEOUT_MS) {
    this.close('handshake timeout');
    // ...
```

```ts
// AFTER
checkTimeout(): void {
  if (this.state === 'closed') return;

  /**
   * The link died without this session closing it — the pulled cable.
   *
   * This guard used to be `if (this.closed) return`, and `closed` is true when *either* this
   * session or its link has gone. So an abrupt drop returned here immediately and `close()`
   * was never reached, which meant `onLeave` was never called and every consequence of a
   * disconnect was skipped.
   */
  if (this.link.state === 'closed') {
    // A fixed reason rather than the link's own: `INetLink` does not carry one, and widening
    // the shared transport interface to improve one log line is not the trade.
    this.close('connection lost');
    return;
  }

  const now = nowMs();
  if (this.state === 'handshaking' && now - this.openedMs > HANDSHAKE_TIMEOUT_MS) {
    this.close('handshake timeout');
    // ...
```

> **The general rule this is an instance of:** a detection path that only fires on an explicit
> message (`bye`, clean close) will never fire on the abrupt failure it exists to handle. When you
> write the Skirmish disconnect handling, test the *pulled cable*, not the polite goodbye.

---

#### 21. `WsServer.maxConnectionsPerIp`

**File:** `src/server/net/WsServer.ts`

Harnesses run every headless client from loopback. Against the shipped per-IP cap, a multi-client
run spends its time proving that the cap works rather than that the flow does. It stays a cap in
every case — only *which* cap is configurable.

```ts
// WsServerOptions — ADD
/** Simultaneous connections from one address. Defaults to `MAX_CONNECTIONS_PER_IP`. */
readonly maxConnectionsPerIp?: number | undefined;
```

```ts
// BEFORE
if (open >= MAX_CONNECTIONS_PER_IP) {
```

```ts
// AFTER
if (open >= (this.opts.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP)) {
```

---

### Shared

---

#### 7a. `EntityInterpolator.snapTo`

**File:** `src/shared/net/Interpolation.ts` (in `EntityInterpolator`, above `reset()`)

**A respawn is a teleport, and a teleport is the one thing an interpolator must not smooth.** The
samples either side of it describe two places the same entity genuinely was, so the bracketing
blend does exactly what it is built to do and drags the body from where it fell to where it came
back — across the map, in a straight line, at whatever speed the interpolation delay implies.

Reported as *"their model is rapidly pulled across the map from their death position to their new
spawn location"*, and it gives the spawn away.

```ts
// ADD
/**
 * Throw the history away and restart from the newest state, stamped at `serverMs`.
 *
 * `reset()` alone is not enough: `sample` returns early with an empty buffer and leaves the
 * pose untouched, so the body would sit at the corpse for a snapshot and then jump. Pushing
 * the post-spawn state back in at the render time means the very next sample is that state,
 * which is a clean cut rather than a slide or a stall.
 *
 * `latest` deliberately survives `reset`, which is what makes this two lines.
 */
snapTo(serverMs: number): void {
  const latest = this.latest;
  this.reset();
  this.push(latest, serverMs);
}
```

> `EntityInterpolator.latest` already exists at M10 (`Interpolation.ts:90`).

---

#### 17. `NetClient.sawMatchOver` latch

**File:** `src/shared/net/NetClient.ts`

Makes *"this client finished a match"* distinguishable from *"this client was **told** the match
finished"*. Without it a headless client acks the `Summary` message and requeues, sailing happily
through a match whose `MATCH_END` phase never arrived — which is precisely the state that left a
browser walking around a finished match with no summary screen.

A latch, not a poll: the header is a *live* record, and the moment a match ends is the moment the
server stops sending, so by the time anything downstream looks the last snapshot may be several
frames old.

```ts
// ADD, next to `readonly header: SnapshotHeader`
/**
 * Whether a snapshot has ever carried `SFlag.MatchOver`.
 *
 * A latch, set during decode, because the header is a *live* record and the moment a match ends
 * is the moment the server stops sending.
 */
sawMatchOver = false;
```

```ts
// onSnapshot — BEFORE
private onSnapshot(byteLength: number): void {
  readSnapshotHeader(this.reader, this.header);
  if (this.reader.overran) return;
```

```ts
// onSnapshot — AFTER
private onSnapshot(byteLength: number): void {
  readSnapshotHeader(this.reader, this.header);
  // Latched here rather than polled by a caller. See `sawMatchOver`.
  if ((this.header.flags & SFlag.MatchOver) !== 0) this.sawMatchOver = true;
  if (this.reader.overran) return;
```

**Companion, so the class of bug is catchable unattended** —
`src/server/debug/HeadlessClient.ts`:

```ts
/** Whether the server ever told this client its match was over. */
get sawMatchEnd(): boolean {
  return this.net.sawMatchOver;
}
```

Assert on it **per match, not latched once** — a churn run plays several, and one silent ending
among four is still the bug.

---

#### 18. `EventBus.subscriptionCount`

**File:** `src/shared/core/EventBus.ts`

The leading indicator for teardown leaks. A process that creates and destroys matches
continuously turns any per-match leak into unbounded growth, and a bus that only grows is
**invisible until hour six**.

Heap moves for a dozen reasons that have nothing to do with a leak — GC timing, a pool not yet
exercised, the allocator's high-water mark — so a flat heap is weak evidence. A subscription count
that returns to the same integer after every match cycle is strong evidence, because it can only
be wrong one way.

```ts
// ADD, above clear()
/**
 * Live listeners across every type.
 *
 * Tombstones are skipped, so this counts what would actually be *dispatched to* rather than
 * what is still occupying a slot. A compacted-away listener costs nothing and does not fire.
 */
get subscriptionCount(): number {
  let n = 0;
  for (const list of this.slots.values()) {
    for (let i = 0; i < list.length; i++) if (list[i] !== null) n++;
  }
  return n;
}

/** Types with at least one live listener. Paired with `subscriptionCount` when it climbs. */
get subscribedTypes(): number {
  let n = 0;
  for (const [, list] of this.slots) {
    for (let i = 0; i < list.length; i++) {
      if (list[i] !== null) {
        n++;
        break;
      }
    }
  }
  return n;
}
```

---

#### 19. Two match clocks

**Files:** `src/shared/modes/GameMode.ts`, `src/shared/modes/MatchFlow.ts`, and each mode's
`onRoundStart` (`Tdm.ts`, `FreeForAll.ts`, `Domination.ts`, `KillConfirmed.ts`,
`SearchAndDestroy.ts`)

There are **two** match clocks and it is not obvious from either side. `MatchFlow` counts
`ticksRemaining` down, and that is what the HUD shows and what the snapshot header replicates —
but **every mode also keeps its own `ticksLeft`**, seeded from its own config, and it is the
mode's clock that `checkWinCondition` reads to decide a match on time. They agree today only
because both are seeded from the same authored number.

A harness that shortened only `MatchFlow`'s clock got a HUD that hit zero and a match that carried
on for another nine minutes.

Left as two clocks deliberately: collapsing them means changing how all five modes decide a time
limit, and the shared simulation is verified and should be **extended, not rewritten**.

```ts
// src/shared/modes/GameMode.ts — ADD to ModeDeps
/**
 * Shorten this mode's round, seconds. Harness only.
 *
 * There are two match clocks and this is the seam between them. Both are overridden from this
 * one value, so they cannot be shortened apart.
 */
readonly roundSecondsOverride?: number | undefined;
```

```ts
// src/shared/modes/GameMode.ts — ADD protected helper to the abstract class
/**
 * How long this mode's round runs, in ticks. The authored length unless a harness said
 * otherwise. See `ModeDeps.roundSecondsOverride` for why both clocks read this.
 */
protected roundTicks(authoredSeconds: number): number {
  const override = this.deps.roundSecondsOverride;
  const seconds = override !== undefined && override > 0 ? override : authoredSeconds;
  return Math.round(seconds / DT);
}
```

```ts
// EACH mode's onRoundStart — BEFORE
this.ticksLeft = Math.round(this.config.timeLimitSeconds / DT);
```

```ts
// EACH mode's onRoundStart — AFTER (the DT import usually becomes unused; drop it)
this.ticksLeft = this.roundTicks(this.config.timeLimitSeconds);
```

```ts
// src/shared/modes/MatchFlow.ts — ADD to MatchFlowDeps
/** Shorten a round, for harnesses only. Unset everywhere a player is involved. */
readonly roundSecondsOverride?: number | undefined;
```

```ts
// src/shared/modes/MatchFlow.ts — ADD accessor
/**
 * How long a round is. The mode's answer, unless a harness said otherwise.
 *
 * **One accessor rather than two call sites reading the same field**, so the override cannot
 * apply to the first round and not to subsequent ones — which is exactly the bug two
 * independent reads would produce in Search & Destroy, presenting as "the soak hangs after
 * round one".
 */
private roundSeconds(): number {
  const override = this.deps.roundSecondsOverride;
  return override !== undefined && override > 0 ? override : this.deps.mode.roundSeconds;
}
```

```ts
// MatchFlow — BOTH seed sites (reset/start AND advanceRound)
// BEFORE
this.ticksRemaining = Math.round(mode.roundSeconds / DT);
this.ticksRemaining = Math.round(this.deps.mode.roundSeconds / DT);
// AFTER — both become
this.ticksRemaining = Math.round(this.roundSeconds() / DT);
```

> This is what makes a fast Skirmish/Warmup soak possible at all: a mode's authored round is ten
> minutes, so a churn run at real length produces six matches an hour and spends 99.9% of itself
> measuring the thing that already works.

---

### Client

---

#### 4. Weapon swap model never updated

**File:** `src/client/ClientMatch.ts` (anchor: line 359, the `WeaponSystem` construction)

`WeaponSystem` defaults `sourceId` to `PLAYER_ENTITY_ID`, which is **0** — right in single-player,
wrong the moment a server assigns an entity id. `Inventory` stamps that id onto
`EV.WeaponSwapped`, and the subscription filters on `identity.is(sourceId)` — so over the network
the swap event announced entity 0, the filter rejected it, and `showSlot` never ran. **The
mechanics changed weapon and the model in your hands did not.**

This is the M10 "client identity hardcoded to zero" bug recurring in the one system that had kept
its own default.

```ts
// BEFORE
this.weapons = new WeaponSystem(
  deps.weaponDef,
  deps.secondaryDef,
  deps.world,
  this.damage,
  deps.bus,
  deps.viewmodelConfig,
  deps.movementConfig.walkSpeed,
);
```

```ts
// AFTER — the 8th parameter already exists in the M10 signature (WeaponSystem.ts:188)
this.weapons = new WeaponSystem(
  deps.weaponDef,
  deps.secondaryDef,
  deps.world,
  this.damage,
  deps.bus,
  deps.viewmodelConfig,
  deps.movementConfig.walkSpeed,
  this.identity.entityId,
);
```

Captured at construction rather than read per event, which is safe because a reassignment tears
the world down and builds a fresh `Match` around the new identity.

---

#### 5. S&D alive counter

**File:** `src/client/ClientMatch.ts` (anchor: lines 1513–1515)

Two faults in two lines, both invisible in single-player.

1. `SearchAndDestroy.aliveCount` walks `ModeDeps.roster`, which on a networked client is
   **empty** — the bodies are `RemoteActor`s rebuilt from snapshots and nothing puts them on a
   roster. It returned 0 for both sides for the whole match: *"constantly shows 0 enemies alive
   even when all 5 enemy bots are active"*.
2. It counted against `PLAYER_TEAM`, the single-player constant, rather than the side the server
   actually assigned. Even with live counts that labels a team-B player's own side as the enemy —
   a counter exactly backwards for half the lobby.

```ts
// ADD — getter, so "which team am I" is never answered by a constant again
/**
 * The side the server put this client on; `PLAYER_TEAM` in single-player.
 *
 * A getter rather than the `deps.localTeam ?? PLAYER_TEAM` expression repeated at each use,
 * because "which team am I" being answered by a constant is precisely how the alive counter
 * came to label a team-B player's own side as the enemy.
 */
get localTeam(): BotTeam {
  return this.deps.localTeam ?? PLAYER_TEAM;
}
```

```ts
// ADD — counts from whichever body source this match has
/**
 * How many of a side are still standing, from whichever body source this match has.
 *
 * Single-player holds `Bot`s on a roster; a networked match holds `RemoteActor`s rebuilt from
 * snapshots. A caller that wants a number should not have to know which. The local player is
 * counted separately because they are in neither list.
 */
countAlive(team: BotTeam): number {
  let n = 0;
  if (this.isNetworked) {
    const actors = this.deps.actors;
    if (actors !== undefined) {
      for (const actor of actors()) {
        if (actor.team === team && actor.participating) n++;
      }
    }
    // A client's own entity is not among its remote actors, so it is never double-counted.
    if (this.localTeam === team && !this.playerDead) n++;
    return n;
  }
  for (const c of this.bots.roster) {
    if (c.team === team && c.participating) n++;
  }
  return n;
}
```

```ts
// BEFORE (lines 1513-1515)
hud.aliveFriendly = mode.aliveCount(PLAYER_TEAM);
hud.aliveEnemy = mode.aliveCount(PLAYER_TEAM === 'A' ? 'B' : 'A');
hud.showAlive = true;
```

```ts
// AFTER
const friendly = this.localTeam;
hud.aliveFriendly = this.countAlive(friendly);
hud.aliveEnemy = this.countAlive(friendly === 'A' ? 'B' : 'A');
hud.showAlive = true;
```

> `MatchDeps.actors` and `MatchDeps.localTeam` both already exist at M10
> (`ClientMatch.ts:167` and `:187`).

---

#### 6. Respawned bodies stuck in the dead pose

**File:** `src/client/ai/BotRenderer.ts` (in `applyEvents`, appended after the flinch branch)

Both the death and spawn branches are edge-triggered, and over the network **both edges routinely
arrive in the same frame**: snapshots are delta-compressed at 20 Hz against a 60 Hz sim, so a body
that died and respawned between two snapshots presents a changed death serial *and* a changed
spawn serial at once.

With the death check second, the mesh ends up face-down on a player who is alive, running around
and shooting — *"they remain stuck in a dead visual state ... they can still move around and shoot
normally"*.

**Reordering cannot fix it.** Spawn-then-die inside one frame is equally possible and would leave
a corpse standing up. The serials carry no ordering relative to *each other*, so no order is
right. `participating` — `EFlag.Alive` off the newest snapshot — does.

```ts
// APPEND to applyEvents(). Leave the three existing serial branches exactly as they are.
    /**
     * The authoritative bit has the last word.
     *
     * The animations stay edge-triggered for their *effects* (fall direction, variant) and the
     * final state is reconciled against the fact. Single-player reaches this with the same
     * `Combatant.participating` it always had, so the two paths agree by construction rather
     * than by coincidence.
     */
    if (bot.participating && mesh.isDying) {
      mesh.endDeath();
      mesh.setVisible(true);
    } else if (!bot.participating && !mesh.isDying) {
      mesh.beginDeath(v.deathDirX, v.deathDirZ, v.deathVariant);
    }
  }
```

> **Generalise this.** Edge-triggered animation state must be reconciled against an authoritative
> bit whenever deltas are slower than the sim. Apply both edges for their effects, then reconcile.

---

#### 7b. `RemoteActor` — snap before sampling

**File:** `src/client/net/RemoteActor.ts` (field + prepended to `update()`)

The client half of [#7a](#7a-entityinterpolatorsnapto).

```ts
// ADD field
/**
 * The spawn serial the *interpolator* has been snapped for.
 *
 * Separate from `visual.spawnSerial`, which `applyLatest` maintains for the renderer's
 * animation triggers, because the two are consumed at different points in the frame — this one
 * has to be acted on **before** the buffer is sampled and that one after. -1 so the first
 * sighting counts as a spawn.
 */
private spawnSnapped = -1;
```

```ts
// PREPEND to update(), before anything samples the buffer
update(interp: EntityInterpolator, renderMs: number): void {
  /**
   * A respawn is a cut, not a move.
   *
   * Detected **before** sampling, which is the whole point: `applyLatest` below already notices
   * the spawn serial, but it runs *after* `interp.sample` has drawn this frame's pose out of a
   * buffer still holding samples from where the body died. Collapsing the render blend there
   * hides the last few milliseconds of the slide and none of the rest of it.
   *
   * The first sighting counts as a spawn too, so a body that has just joined appears where it
   * is rather than travelling there from the origin.
   */
  const spawnSerial = interp.latest.spawnSerial;
  if (spawnSerial !== this.spawnSnapped) {
    this.spawnSnapped = spawnSerial;
    interp.snapTo(renderMs);
    this.seeded = false;
  }

  // ...existing body unchanged...
```

---

#### 8. Respawn timer frozen at 4.5

**File:** `src/client/ClientMatch.ts`

`stepPlayerRespawn` does two things — it decrements the timer *and* it brings the body back — and
over the network the second belongs to the server, so the whole method was skipped. The timer was
therefore set once by `onPlayerKilled` and never moved: the death screen showed a frozen `4.5` for
the entire wait and then the player simply reappeared.

**The wait was always correct; the only thing broken was the number describing it.**

```ts
// ADD
/**
 * Count the death-screen timer down, and **only** that.
 *
 * Purely presentational, and clamped at zero rather than allowed to run negative: the
 * authoritative "you are alive again" is the replicated `EFlag.Alive` arriving through
 * `applyReplicatedSelf`, and this must never be mistaken for a second opinion about it. If the
 * server is slower than the local estimate the display sits at zero and waits, which reads as
 * "any moment now" — the honest thing for a client that does not decide.
 */
private stepRespawnDisplay(): void {
  if (!this.playerDead || this.playerRespawnTimer <= 0) return;
  this.playerRespawnTimer = Math.max(0, this.playerRespawnTimer - DT);
}
```

```ts
// BEFORE — in the per-tick body
// The server owns when and where a body comes back; the client is told.
if (!this.isNetworked) this.stepPlayerRespawn();
```

```ts
// AFTER
if (!this.isNetworked) this.stepPlayerRespawn();
else this.stepRespawnDisplay();
```

---

#### 10. Handshake dropped frames behind `Identity`

**File:** `src/client/net/Handshake.ts`

`BrowserLink.poll` hands the whole queue to its callback and then clears it, so anything behind
the `Identity` in the same batch has already been dequeued by the time the handshake resolves.
`awaitIdentity` dropped those on the floor.

Harmless for a fresh connect — nothing follows an `Identity` for a client that has not asked for
anything yet. **A reconnect breaks that assumption**: the server reseats a returning player and
sends the seat assignment immediately after the `Identity`, so the two land microseconds apart and
reliably share a batch. Measured: the server logged *"reconnected into match 1 as entity 1"*; the
client logged *"No match yet"*, waited out its timer, and requeued — having thrown away the frame
that said it was already back in.

```ts
// HandshakeResult — ADD
/**
 * Frames that arrived **after** the `Identity` but in the same drain.
 *
 * Carried out rather than discarded, and replayed into the session the moment it exists.
 * Ordinarily empty.
 */
readonly pending: readonly Uint8Array[];
```

```ts
// awaitIdentity signature — BEFORE
function awaitIdentity(link: BrowserLink): Promise<{ identity: IdentityInfo; receivedAtMs: number }> {
```

```ts
// AFTER
function awaitIdentity(
  link: BrowserLink,
): Promise<{ identity: IdentityInfo; receivedAtMs: number; pending: Uint8Array[] }> {
```

```ts
// inside the promise body — ADD
/** Frames behind the `Identity` in the same drain. See `HandshakeResult.pending`. */
const pending: Uint8Array[] = [];
```

```ts
// the poll callback — BEFORE
link.poll((bytes) => {
  if (settled) return;
  reader.reuse(bytes);
```

```ts
// AFTER
link.poll((bytes) => {
  /**
   * Already have the identity: keep the rest of this batch rather than discarding it.
   *
   * Copied because `poll` clears its queue immediately after this callback returns and the
   * underlying buffers are the link's to reuse.
   */
  if (settled) {
    pending.push(bytes.slice());
    return;
  }
  reader.reuse(bytes);
```

```ts
// the identity case — BEFORE
finish(() => resolve({ identity, receivedAtMs: performance.now() }));
```

```ts
// AFTER
/**
 * `settled` is set by `finish` *before* the resolve runs, so any frame still to be delivered
 * in this same `poll` batch takes the `pending` branch above rather than the switch. That
 * ordering is the whole mechanism.
 */
const receivedAtMs = performance.now();
finish(() => resolve({ identity, receivedAtMs, pending }));
```

```ts
// handshake() — thread it through the return
const { identity, receivedAtMs, pending } = await awaitIdentity(link);
return { link, identity, receivedAtMs, pending };
```

Replay `pending` into whatever owns the post-handshake session. Pairs with
[Tier 2 §D](#d-afteridentity-ordering-contract).

---

#### 14. FFA banner showed A-vs-B

**Files:** `src/client/ui/HudBanner.ts`, `src/client/ClientMatch.ts`,
`src/client/ui/styles/hud.css`

Free-for-All keeps the two-team substrate internally and the banner read it literally — so eight
individuals were presented as a team score that means nothing to anybody in the match. The numbers
an FFA player tracks are *who is winning* and *where am I*.

The same two slots, relabelled, rather than a second banner: the layout, the bars, the
change-guards and the tabular numerals are all still exactly what is wanted.

```ts
// BannerState — ADD
/** Free-for-All: there are no teams to put on either side of the clock. */
ffa: boolean;
/** Leader's name and score, FFA only. */
leaderName: string;
leaderScore: number;
/** This client's own score, FFA only. */
selfScore: number;

// makeBannerState() — ADD
ffa: false,
leaderName: '',
leaderScore: 0,
selfScore: 0,
```

```ts
// HudBanner — ADD fields
/** FFA captions above each score. Empty and hidden in team modes. */
private readonly labelA: HTMLElement;
private readonly labelB: HTMLElement;
private lastFfa = false;
private lastLeadLabel = '';
```

```ts
// HudBanner constructor — build the labels and prepend them to each side
this.labelA = document.createElement('span');
this.labelA.className = 'hud-banner__who op-label';
this.labelA.hidden = true;
this.labelB = document.createElement('span');
this.labelB.className = 'hud-banner__who op-label';
this.labelB.hidden = true;

// BEFORE: teamA.append(this.scoreA, trackA);
teamA.append(this.labelA, this.scoreA, trackA);
// BEFORE: teamB.append(this.scoreB, trackB);
teamB.append(this.labelB, this.scoreB, trackB);
```

```ts
// update() — BEFORE
if (state.scoreA !== this.lastA) {
  this.lastA = state.scoreA;
  this.scoreA.textContent = String(state.scoreA);
}
if (state.scoreB !== this.lastB) {
  this.lastB = state.scoreB;
  this.scoreB.textContent = String(state.scoreB);
}

const limit = state.limit > 0 ? state.limit : 1;
const fillA = Math.round(Math.min(1, state.scoreA / limit) * 100) / 100;
const fillB = Math.round(Math.min(1, state.scoreB / limit) * 100) / 100;
```

```ts
// update() — AFTER
/**
 * In Free-for-All the two sides are **leader** and **you**, not team A and team B.
 *
 * The left slot is whoever is winning and the right is this client, so "am I close" is the
 * same glance it is in a team mode.
 */
const left = state.ffa ? state.leaderScore : state.scoreA;
const right = state.ffa ? state.selfScore : state.scoreB;

if (state.ffa !== this.lastFfa) {
  this.lastFfa = state.ffa;
  this.element.classList.toggle('hud-banner--ffa', state.ffa);
}
const leadLabel = state.ffa ? state.leaderName || 'LEADER' : '';
if (leadLabel !== this.lastLeadLabel) {
  this.lastLeadLabel = leadLabel;
  this.labelA.textContent = leadLabel;
  this.labelA.hidden = leadLabel === '';
  this.labelB.textContent = state.ffa ? 'YOU' : '';
  this.labelB.hidden = !state.ffa;
}

if (left !== this.lastA) {
  this.lastA = left;
  this.scoreA.textContent = String(left);
}
if (right !== this.lastB) {
  this.lastB = right;
  this.scoreB.textContent = String(right);
}

const limit = state.limit > 0 ? state.limit : 1;
const fillA = Math.round(Math.min(1, left / limit) * 100) / 100;
const fillB = Math.round(Math.min(1, right / limit) * 100) / 100;
```

```ts
// src/client/ClientMatch.ts — ADD, and call it from the HUD fill alongside fillObjectiveBanner
/**
 * Free-for-All shows the leader and you, not team A and team B.
 *
 * Driven from `ScoreSystem.rows`, which is populated on a networked client the same way the
 * scoreboard is. Recomputed per frame rather than cached on a score event — it is a scan of ten
 * rows on a screen that is already walking them for the scoreboard.
 */
private fillFreeForAllBanner(): void {
  const banner = this.ui.state.banner;
  banner.ffa = this.deps.mode.freeForAll === true;
  if (!banner.ffa) return;

  let leader: { name: string; score: number } | null = null;
  let self = 0;
  for (const row of this.score.rows) {
    if (row.entityId === this.localId) self = row.score;
    if (leader === null || row.score > leader.score) {
      leader = { name: row.displayName, score: row.score };
    }
  }
  banner.leaderName = leader?.name ?? '';
  banner.leaderScore = leader?.score ?? 0;
  banner.selfScore = self;
}
```

```css
/* src/client/ui/styles/hud.css — ADD */
/* Free-for-All only: the two slots are LEADER and YOU rather than two teams, so they need
   naming — the accent colours that distinguish A from B mean nothing when there are no sides.
   Clipped, because a display name is untrusted input. */
.hud-banner__who {
  font-size: var(--t-micro);
  color: var(--c-text-dim);
  line-height: 1;
  max-width: 12ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

---

#### 15. Domination flag colours backwards for team B

**File:** `src/client/ClientMatch.ts` (the Domination zone fill)

The constant is team A, so a networked player the server put on team B had every flag on their
minimap coloured backwards: their own held zones read as enemy and the enemy's as theirs.

```ts
// BEFORE
state.owner = zone.owner === 'NONE' ? 'NONE' : zone.owner === PLAYER_TEAM ? 'FRIENDLY' : 'ENEMY';
```

```ts
// AFTER
const friendly = this.localTeam;
state.owner = zone.owner === 'NONE' ? 'NONE' : zone.owner === friendly ? 'FRIENDLY' : 'ENEMY';
```

---

#### 16. Thermal/gunship pass drew own side hot

**File:** `src/client/Game.ts` (the `renderGunship` call)

A networked gunner the server put on team B had the thermal pass draw their own side hot and the
enemy cold — the optic reading exactly backwards, in the one streak whose entire value is telling
friend from foe.

```ts
// BEFORE
const enemyTeam = PLAYER_TEAM === 'A' ? 'B' : 'A';
this.renderer.renderGunship(
  this.scene,
  takeover,
  match.botRenderer.groupFor(enemyTeam),
  match.botRenderer.groupFor(PLAYER_TEAM),
);
```

```ts
// AFTER
const friendly = match.localTeam;
const enemyTeam = friendly === 'A' ? 'B' : 'A';
this.renderer.renderGunship(
  this.scene,
  takeover,
  match.botRenderer.groupFor(enemyTeam),
  match.botRenderer.groupFor(friendly),
);
```

---

> ### 🔴 Fixes 5, 15 and 16 are one bug in three places
>
> `PLAYER_TEAM` — the single-player constant `'A'` — standing in for a server-assigned side.
> Each one was found separately, months apart, in the last place it was still hiding.
>
> **After applying these, grep `PLAYER_TEAM` across `src/client/` and justify every remaining
> hit.** Anything that answers "which side am I on" must go through `Match.localTeam`.

---

## Tier 2 — needs translation

These have no direct port because the file they lived in dies with the rollback. The *reasoning*
is what carries forward.

### A. Match-end race — the guard, restated for a new flow

**Does not manifest at M10.** `GameServer.tick` keeps ticking after `match.isOver` (endHold →
rotate), so the phase always reaches a snapshot tick within ~50 ms. It bites the moment your
Skirmish flow does what `MatchInstance` did: end the match and stop stepping in the same tick.

The sim runs at 60 Hz and snapshots go out at 20, so `shouldSnapshot` is true on **one tick in
three**. If the deciding tick is not a snapshot tick, the header carrying `phase = MATCH_END` is
never sent, and the client's `MatchFlow.applyReplicated` never sees the transition that fires
`EV.MatchEnded`.

Everything downstream of a match ending hangs off that event — the summary screen, the announcer,
the world teardown, `Game.pendingSummary`. **None of them fire.** The symptom reads like three
separate bugs: the bots stop (the server stopped stepping them), the player keeps walking (nothing
told the client), no summary appears, and the menu is unreachable afterwards because the client
never left `MATCH`.

**Measured:** 9 of 15 matches never replicated `MATCH_END`, against the 2-in-3 the theory
predicts. With the fix, 15 of 15.

```ts
// Wherever your Skirmish flow decides to stop stepping:
const ending = this.state_ === 'RUNNING' && match.isOver;
if (this.shouldSnapshot(tick) || ending) {
  this.buildEntities();
  this.sendSnapshots(tick);
}
```

> **The rule to write into the new flow: force a snapshot on any tick that ends the stepping.**

**The client half.** M11 added a *second, independent* route to the summary, attached to the
master's `Summary` message — which will not exist. M10 already sets `pendingSummary` from
`onMatchEnded` (`Game.ts:702`, driven by `EV.MatchEnded`). Keep the **principle**:

> A state transition that hangs the client when its single signal is missed should not have a
> single signal.

Give the Skirmish flow a second reliable path to the summary, and make it idempotent (M11's guard
was *"only act while the state is still `MATCH`"*).

**Also carry [#17](#17-netclientsawmatchover-latch)** — the harness could not previously catch
this, because a headless client acks the `Summary` message and requeues regardless.

---

### B. The `replaceChildren` discipline + template

**A DOM node that is replaced cannot be clicked.**

A browser fires `click` only when `mousedown` and `mouseup` land on the same element. Any UI
rebuilt on a periodic broadcast (M11's was 4 Hz) destroys the row under the pointer every 250 ms,
so a click registers *only* if the whole press happens to fall between two rebuilds. Reported as
*"clicking on a map requires multiple clicks; a single click does not work"* — which is exactly
what a 250 ms window looks like from the other side.

Build rows once, key them, update in place. Rebuild **only** when the row *set* changes:

```ts
// Template — the shape to reuse in any periodically-updated Skirmish/Warmup UI
private renderRows(view: View): void {
  // The set of rows only changes when the underlying collection does.
  const wanted = view.items.map((v) => v.id).join('|');
  if (wanted !== this.rowsKey) {
    this.rowsKey = wanted;
    this.rows.clear();
    this.hostEl.replaceChildren();
    for (const item of view.items) this.hostEl.appendChild(this.buildRow(item.id));
  }

  // Every broadcast: write text, classes and widths into the *surviving* nodes.
  for (const item of view.items) {
    const row = this.rows.get(item.id);
    if (row === undefined) continue;
    row.button.classList.toggle('op-option--on', item.self);
    row.button.disabled = !item.enabled;
    row.button.setAttribute('aria-pressed', item.self ? 'true' : 'false');
    row.count.textContent = String(item.count);
    row.fill.style.width = `${item.pct}%`;
  }
}

private buildRow(id: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'op-option';
  // ...children...
  button.addEventListener('click', () => this.deps.onSelect(id));   // attached ONCE
  this.rows.set(id, { button, count, fill });
  return button;
}
```

This is the same discipline `MatchObjectives` uses for capture rings — there it is a performance
point, here it is a **correctness** one.

> ⚠️ M11 never landed a real click test on this. The browser attempt hit a stale hidden lobby
> screen, so it is verified **structurally only** (the node survives a broadcast). **Make a real
> single-click test a playtest item.**

---

### C. Session state: "connected" ≠ "in a match"

M10's `SessionState` is `'handshaking' | 'playing' | 'closed'`, and the timeout logic assumes
`NetClient`'s ping keeps a session alive — true only while the client is *in a match*.

M11 found this the hard way: a queued player was dropped after ten seconds, because a 30 s lobby
has no `NetClient` at all. **A Skirmish/Warmup flow has exactly this shape** — a connected client
that is not yet simulating.

- Rename the state to something honest (M11 used `'live'`), so "connected" and "playing" are not
  the same word.
- Make sure something keeps the session alive during warmup — either a heartbeat from the client
  or a timeout that knows the difference.

> **The meta-lesson, and it cost a real bug:** this was found by the browser and **not** by the
> harness, which ran a 6 s countdown and reached a match inside the timeout every time. *A harness
> that shortens a timer to go faster can shorten past the bug it exists to find.* Run at least one
> pass at real timings.

---

### D. `afterIdentity` ordering contract

Pairs with [#10](#10-handshake-dropped-frames-behind-identity). Any side effect of a reconnect
that sends a frame must not run inside the hello handler, or its frame overtakes the `Identity`
it is a reply to.

```ts
// SessionHost.onHello return type — ADD
/**
 * Work that must not happen until `Identity` has left the building.
 *
 * A reconnect reseats the session, and reseating sends a seat assignment. Done inside `onHello`,
 * that frame goes out *before* the `Identity` whose reply it is, and the client's very first
 * frame after a `Hello` is an assignment it has no context for yet — so the handshake drops it.
 *
 * The ordering becomes a property of this contract rather than of the order two functions
 * happen to be called in.
 */
afterIdentity?: () => void;
```

```ts
// Session — call it LAST, after the identity frame has been sent and the log line written
identity.afterIdentity?.();
```

This makes *"`Identity` is the first frame after a `Hello`"* a guarantee the server makes on every
path, rather than an assumption the client hopes for.

---

## Tier 3 — already in M10, do NOT re-apply

All of these are committed **before** the `m10-complete` tag and survive the rollback. Re-applying
them is wasted effort and will conflict.

| Fix | Commit | Verify it survived |
|---|---|---|
| Frozen after respawn — three notions of "am I dead" | `a2d1fec` | `ClientMatch.applyReplicatedSelf`, `respawnNetworked`, `netFrozen` |
| Replicated HUD clock — phase, phase seconds, round in the header | `a2d1fec` | `MatchFlow.applyReplicated` |
| `spawnPlayer` falls back to the map's first authored spawn | `a2d1fec` | `ServerMatch.spawnPlayer` |
| Headless client reports `metresSinceRespawn` | `a2d1fec` | `HeadlessClient` |
| The server owns map/mode selection, not the local menu | `afe7399` | `NetClient.mapId` / `modeId` actually read |
| Hit markers and audio feedback over the network | `afe7399` | — |
| Match state not surviving into the next match | `afe7399` | — |

---

## Standing lessons worth keeping

Recorded because each one cost a real bug this milestone, and each will apply again during the
Skirmish/Warmup rewrite.

1. **Turning off a client-side system is half a change.** Every `if (!this.isNetworked)` is a
   place where something authoritative must arrive instead, and the compiler cannot tell you when
   it does not — the field still exists, still has a plausible value, and still renders. Grep for
   that guard before adding another, and for each, name what replicates in its place.

2. **"Implemented but not verified" usually means unreachable.** Trace call sites before trusting
   any handover claim. Three separate M11 features were complete code with no caller. Check the
   *inverse* too: a detection path that only fires on an explicit message will never fire on the
   abrupt failure it exists to handle ([#9](#9-ungraceful-disconnect-never-fired-onleave)).

3. **A client's copy is one snapshot stale, always.** Any comparator checking live server state
   against client state must tolerate latency on continuously-varying values and
   confirm-before-reporting on discrete ones. Exact equality is a broken test, not a found bug.

4. **Tests must be able to fail.** M11 logged five false-greens, every one an *absence read as a
   result*. Always stub the mechanism and watch the probe go red before believing it green.

5. **A probe can alias against the thing it measures.** Before choosing a sampling interval, ask
   what periods exist in the system (sweep, fade, the 20 Hz snapshot, the round) and pick one that
   is not near a multiple of any of them.

6. **A flaky probe is worse than no probe.** A probe that needs somebody alive at an instant
   chosen in advance teaches its reader to re-run until green, which is how a real regression gets
   waved through. Drive probes off *what is still missing*, and retry.

7. **Prediction requires `PlayerController.step` to be a pure function of (state, command) across
   both runtimes.** Anything that alters movement must be set identically on both sides
   ([#20](#20-lightweight--permanent-misprediction)).

8. **Ids on the wire, not resolved numbers.** A def-table reorder must not silently change what a
   byte means. Net modules should declare their own wire-order tables.

---

## Post-application playtest checklist

Nothing headless can see these. Carried forward from M11's pending QA, minus the
matchmaking-specific items.

- [ ] **Single click registers once** in any periodically-updated UI (Tier 2 §B).
- [ ] **Respawn timer counts down** instead of freezing at 4.5 ([#8](#8-respawn-timer-frozen-at-45)).
- [ ] **Respawned bodies are not stuck lying flat** ([#6](#6-respawned-bodies-stuck-in-the-dead-pose)).
- [ ] **Respawns cut** to the spawn point instead of sliding across the map ([#7a](#7a-entityinterpolatorsnapto)/[7b](#7b-remoteactor--snap-before-sampling)).
- [ ] **Weapon-swap model changes** when you switch to the pistol ([#4](#4-weapon-swap-model-never-updated)).
- [ ] **FFA banner shows leader/you**, and every bot is damageable ([#14](#14-ffa-banner-showed-a-vs-b), [#1](#1-ffa-friendly-fire)).
- [ ] **S&D alive counter shows real numbers for both sides** ([#5](#5-sd-alive-counter)).
- [ ] **Domination flag colours are right for a player the server put on team B** ([#15](#15-domination-flag-colours-backwards-for-team-b)).
- [ ] **Thermal pass as a team-B player** — own side dark, enemies hot ([#16](#16-thermalgunship-pass-drew-own-side-hot)).
- [ ] **Pull the cable** (not a clean quit) and confirm the seat is held and reclaimable ([#9](#9-ungraceful-disconnect-never-fired-onleave)).
- [ ] **Bots hold still during the countdown** ([#2](#2-bots-ignore-the-pre-match-freeze)).
- [ ] **Match end reaches the summary** every time, not two in three (Tier 2 §A).
