/**
 * Cheat codes, and the entitlements they grant (M11 Gate B, playtest round 4, F14).
 *
 * ## A code is input; an entitlement is state
 *
 * That sentence is the whole of this file and the reason it exists at all. The report asks for
 * six codes, and the naive build is six booleans written by six keypress handlers — at which
 * point every effect has to ask *"was the code typed"*, the server has no way to be the source
 * of truth about any of it, and turning the whole thing off is six edits.
 *
 * So the code is parsed **once**, into a mask of entitlements, and every effect downstream reads
 * the mask and nothing else. `check-cheats.mjs` enforces the half of that a human would forget:
 * no code string appears anywhere outside this file.
 *
 * ## Two authorities, one store, and the partition is the security argument
 *
 * `SPEC[]1` to `SPEC[]4` change what the **simulation** says: whether a round hurts you, whether
 * a bot comes looking, whether a wall stops you. Against a dedicated server a client granting
 * itself those is not a cheat code, it is an exploit — it either does nothing (the server keeps
 * killing you) or it works, and then it is a hole. So those bits are `CHEAT_SIMULATION`, and the
 * **server is their only author**; a client's copy is replicated state it reads and never writes.
 *
 * `DEBUG666` changes a client surface and nothing else, so the client authors it — and it grants
 * **no entitlement at all**. It is `kind: 'surface'`, it never reaches the wire, and there is no
 * bit anywhere in this file for it. Gating it behind the server flag would make the debug overlay
 * unreachable in single-player, where there is no server, and unreachable against a deployed one
 * — which is exactly where every "needs a browser" list in PLAN.md sends somebody to read the
 * NetPanel.
 *
 * So **every bit in the table below is server-authored**, without exception, and `Game.cheatMask`
 * is one mask from one authority rather than a merge of two halves. `check-cheats.mjs` enforces
 * the property that makes that true: a `'surface'` code may not carry entitlement bits.
 *
 * F14 gave `DEBUG666` a bit, and the bit was a second copy of `debugRequest` — which round four's
 * B1 had already established as *the* single store for "is the overlay wanted", after a defect
 * whose description was *"two copies of 'is the debug overlay open', and the × wrote one of
 * them"*. The × wrote one of them again: it cleared the request and left the bit, so typing the
 * code after closing the panel read as *"off"* and a third press was needed to reopen. Deleting
 * the bit is the fix, and it is B1's fix a second time.
 *
 * ## Every entitlement's lifetime, and where it is cleared
 *
 * F14 shipped without this table and the omission was the whole of the regression that followed:
 * the store was put on the `Session`, which outlives a seat, and every entitlement in it was
 * therefore granted for longer than the thing it was granted against. A cheat typed in the arena
 * followed the player into the live match; the receipt for a wallet payment outlived the wallet.
 *
 * | Entitlement | Kind | Lifetime | Cleared, server | Cleared, client |
 * |---|---|---|---|---|
 * | `DEBUG666` | surface | **the session** — the tab | never sent | it *is* `debugRequest`; the ×, Escape and the code all write that one value. Deliberately survives a migration and a rotation |
 * | `Cheat.God` | toggle | **the seat** — one instance | `MatchInstance.unseat` | `NetClient.onWelcome`'s S4.18 discard |
 * | `Cheat.Unseen` | toggle | the seat | same | same |
 * | `Cheat.NoClip` | toggle | the seat | same | same |
 * | the wallet payment | **instant** | the payment is over the moment it lands; what it pays *into* belongs to a life (`StreakLedger.resetLife`) | nothing to clear — no bit is kept | the caption expires after `CHEAT_NOTICE_SECONDS`, and `onMigrated` drops it |
 *
 * **The seat, not the connection, is the unit.** A migration destroys the entity, the scoreboard
 * seat's streak ledger row (`removePlayer` runs `StreakSystem.onOwnerRemoved`, which is `onDeath`
 * plus `ledger.forget`) and the encoder — so an entitlement that survived it was an entitlement
 * against an entity that no longer existed. It is also the *silent* case rather than the loud one:
 * god mode in the arena does nothing at all, because F7 already spares every combatant in that
 * room, so the only place it means anything is a live match — and carrying it in from a room where
 * it was a no-op is exactly how nobody notices.
 *
 * ## Why `shared/`
 *
 * The same reason `HudSurfaces` and `pickSpectatorTarget` are here: the server parses codes and
 * the client parses codes, and two spellings of "SPEC[]4 means all three" is two places to get
 * it wrong. Nothing here touches the DOM.
 */

/**
 * One entitlement per bit. The mask crosses the wire as a single byte.
 *
 * **Every bit here is a state a player can be *in*, and every one of them is the server's.**
 * Two bits have been removed since F14 and both for the same reason — they were not states:
 *
 * - `Wallet` was a receipt for a transaction, and it outlived the ledger row it described.
 * - `Debug` was a second copy of `debugRequest`, and only one of the two was written when the
 *   panel was dismissed.
 *
 * The bits that remain are the three the simulation reads. If a candidate bit has no line in
 * `Perception`, `DamageSystem` or `PlayerController` that reads it, it is not one of these.
 */
export const Cheat = {
  /** Takes no damage. `Damageable.invulnerable`, tested at the damage door. */
  God: 1 << 1,
  /** Nothing comes looking. `Combatant.participating`, tested by perception and spawn scoring. */
  Unseen: 1 << 2,
  /** Flies through the world. `PlayerController.noclip`. */
  NoClip: 1 << 3,
} as const;

export type CheatBit = (typeof Cheat)[keyof typeof Cheat];

/**
 * Every entitlement bit there is, and all of them the server's.
 *
 * Kept as a named mask rather than folded away, because `NetClient` masks the incoming byte with
 * it — so a bit retired from the table above is filtered on arrival rather than misread, which is
 * what let two removals happen without a protocol bump.
 */
export const CHEAT_SIMULATION = Cheat.God | Cheat.Unseen | Cheat.NoClip;

/** Everything `full spectator` means. See `SPEC[]4`. */
export const CHEAT_FULL_SPECTATOR = Cheat.God | Cheat.Unseen | Cheat.NoClip;

/**
 * What kind of thing a code does, **declared** rather than inferred at each reader.
 *
 * Three kinds, and the differences are all differences of *lifetime*:
 *
 * - `'toggle'` — a state a player is in until they leave it. It has an entitlement bit, the
 *   server owns it, it is replicated, and the HUD shows it for as long as it is true.
 * - `'instant'` — a transaction, over the moment it lands. No bit, nothing replicated, and the
 *   HUD *announces* it for a display duration.
 * - `'surface'` — a client surface with no simulation behind it. No bit, never sent to the
 *   server, and the store it writes is the one that already owns that surface.
 *
 * The kind is the discriminant and there is no second flag beside it. F14 carried a `local`
 * boolean as well, which meant the same thing as `'surface'` does and could disagree with the
 * bits; `check-cheats.mjs` now enforces the invariant that made that flag redundant — a
 * `'surface'` code carries no entitlement bits, so a client can never author one.
 */
export type CheatKind = 'toggle' | 'instant' | 'surface';

/**
 * What a recognised code asks for. The discriminant is the kind above.
 *
 * A toggle carries the bits it flips. An instant carries its payload — today only `kills`, and a
 * second kind of payment would add a field here rather than a branch anywhere downstream. A
 * surface carries nothing: which surface is the client's business, and there is exactly one.
 */
export type CheatEffect =
  | { readonly kind: 'toggle'; readonly bits: number }
  | { readonly kind: 'instant'; readonly kills: number }
  | { readonly kind: 'surface' };

/** A recognised code: what it is called and what it does. */
export interface CheatCode {
  readonly code: string;
  readonly effect: CheatEffect;
}

/**
 * Kills granted by `MO951357`, and the number is the report's.
 *
 * Thirty is above every price in `STREAK_DEFS`, which is the point: one code makes the whole of
 * a class affordable so the three-slot strip, the price list and B10's once-per-life rule can all
 * be exercised in one match without staging a twelve-kill streak first.
 */
export const CHEAT_WALLET_KILLS = 30;

/**
 * The table. Nothing outside this file may name a code string.
 *
 * `SPEC[]n`'s brackets are **typed characters, not keystrokes**. The input is a text field on the
 * pause screen (see `PauseMenu`), so what a player types is the literal text below — which is
 * also why there is no key-sequence detector anywhere in this feature and no question about what
 * `[` is on a keyboard that does not have one.
 */
const CODES: readonly CheatCode[] = [
  { code: 'DEBUG666', effect: { kind: 'surface' } },
  { code: 'SPEC[]1', effect: { kind: 'toggle', bits: Cheat.God } },
  { code: 'SPEC[]2', effect: { kind: 'toggle', bits: Cheat.Unseen } },
  { code: 'SPEC[]3', effect: { kind: 'toggle', bits: Cheat.NoClip } },
  { code: 'SPEC[]4', effect: { kind: 'toggle', bits: CHEAT_FULL_SPECTATOR } },
  { code: 'MO951357', effect: { kind: 'instant', kills: CHEAT_WALLET_KILLS } },
];

/**
 * The code whose toggle is exactly these bits, or null.
 *
 * For the surfaces that ask for an entitlement **programmatically** — the QA spectator panel and
 * the console — rather than by having somebody type a string. They name `Cheat` bits, look the
 * code up here, and send that; so there is still exactly one input to this feature, and
 * `check-cheats.mjs` can go on refusing a code literal anywhere outside this file.
 *
 * The alternative was a second door that granted bits directly, which is precisely the shape
 * that would let a client author a simulation entitlement without asking anybody.
 */
export function cheatCodeToggling(bits: number): string | null {
  for (const entry of CODES) {
    if (entry.effect.kind === 'toggle' && entry.effect.bits === bits) return entry.code;
  }
  return null;
}

/**
 * How long an **instant** cheat's caption stays on screen, seconds.
 *
 * Four: long enough to read three words while a firefight is going on, short enough that it is
 * gone before the next thing happens. Chosen and written down rather than picked silently,
 * because a number nobody argued for is a number nobody can change.
 *
 * **This is a display duration, not a delay.** P0 bans *"a timer or delay to let state settle"* —
 * a timer standing in for a signal that has not arrived. Nothing waits on this one: the payment
 * has already landed and been logged by the time the caption goes up, and the caption expiring
 * changes no state at all. It is the same kind of number as `HudTactical`'s 1.1 s hit-direction
 * chevron and the damage numbers' own fade.
 *
 * Counted down from a **deadline** rather than integrated as a duration, which is B4's lesson: a
 * duration is only true at the instant it is created, and it goes on counting through a pause the
 * screen it belongs to did not survive.
 */
export const CHEAT_NOTICE_SECONDS = 4;

/**
 * Longest code the wire will carry, in bytes.
 *
 * A cap rather than "read what is left in the frame": a length an attacker chooses is not a
 * length. The decoder is `ByteReader.str`, which is already bounded by its own byte count; this
 * is the *semantic* bound, applied where the meaning is, and anything longer is refused as
 * malformed rather than compared against the table.
 */
export const CHEAT_CODE_MAX = 24;

/**
 * Recognise a code, or null.
 *
 * Case-insensitive and trimmed, because the input is a text field and "debug666" is the same
 * intent as "DEBUG666". Nothing else is normalised — in particular the brackets are not
 * optional, since `SPEC1` would be a different string a player might reasonably expect to mean
 * something else later.
 */
/** Whether this code is the client's own business and must never reach the wire. */
export function isSurfaceCheat(entry: CheatCode): boolean {
  return entry.effect.kind === 'surface';
}

export function parseCheatCode(raw: string): CheatCode | null {
  if (raw.length > CHEAT_CODE_MAX) return null;
  const text = raw.trim().toUpperCase();
  for (const entry of CODES) if (entry.code === text) return entry;
  return null;
}

/**
 * Apply a toggle to a mask, and return the new one.
 *
 * The rule for a multi-bit code — `SPEC[]4` — is the one `SpectatorPanel`'s "toggle full
 * spectator" button has used since M8: pressing it while a *subset* is on completes the set
 * rather than turning things off, and only a press with everything already on clears it. That is
 * what somebody reaching for one control wants.
 *
 * ## This is a toggle, and a toggle cannot express "off"
 *
 * Read the two branches: for a multi-bit `bits`, the *only* mask that clears is the one that
 * already holds every bit. Every other mask **widens** to the full set.
 *
 * | mask | `toggleCheat(mask, God|Unseen|NoClip)` |
 * |---|---|
 * | `0` | **all three** |
 * | `God` | **all three** |
 * | `God+Unseen` | **all three** |
 * | all three | `0` |
 *
 * That is correct as a toggle and catastrophic as a way of saying *"turn these off"*, which is
 * exactly what `DebugSuite.dispose` was doing through `Spectator.reset()`: a player holding god
 * mode alone was migrated, the teardown asked to toggle all three, the request landed on a mask
 * the migration had already cleared to zero — and arrived in the next match with **everything**
 * on. One kill and a mask of 2 became a mask of 14.
 *
 * So a caller that wants a *state* must not use this. `codesClearing` below is the verb for that,
 * and `check-cheats.mjs` proves it over every subset.
 */
export function toggleCheat(mask: number, bits: number): number {
  const all = (mask & bits) === bits;
  return all ? mask & ~bits : mask | bits;
}

/**
 * The toggles that turn `bits` off, given the mask they are currently in.
 *
 * The verb `toggleCheat` cannot be: *"off"* is a state and a toggle is a relative move, and the
 * two coincide only when every bit is already set. So this returns **one single-bit toggle per
 * bit that is actually set** — correct for any mask, and the only thing expressible, because a
 * toggle is the only input this feature has and giving it a second, absolute one is exactly what
 * would let a client author an entitlement.
 *
 * Single-bit toggles only, and deliberately: a multi-bit code is the thing that cannot express
 * "off", so it is never part of the answer. Returned as bits for the caller to request through
 * the same door a typed code goes through, so the server stays the authority; empty when there is
 * nothing to clear, which is what makes calling it unconditionally safe.
 *
 * `check-cheats.mjs` folds `toggleCheat` over the result for **every one of the eight possible
 * masks** and requires exactly zero. That is the proof the reported mutation cannot come back:
 * one bit in must not become three bits out.
 */
export function bitsClearing(mask: number, bits: number): readonly number[] {
  const out: number[] = [];
  for (const entry of CODES) {
    if (entry.effect.kind !== 'toggle') continue;
    const single = entry.effect.bits;
    if (single === 0 || (single & (single - 1)) !== 0) continue;
    if ((mask & single & bits) !== 0) out.push(single);
  }
  return out;
}

/**
 * Why a request ended the way it did, for the client to say out loud.
 *
 * A refusal that is silent is a bug reported twice — the player retypes the code, gets the same
 * nothing, and files it as "cheats don't work" rather than as "this server has them off". So the
 * outcome is part of the reply rather than inferred from a mask that did not change, which is
 * also the only way `Revoked` and `RefusedDisabled` can be told apart: both leave the mask
 * without the bit.
 */
export const CheatOutcome = {
  Granted: 1,
  Revoked: 2,
  /** The code is real and this server has cheats switched off. */
  RefusedDisabled: 3,
  /** No such code. */
  RefusedUnknown: 4,
  /** An `'instant'` cheat was applied. Its caption is the client's to raise; nothing latches. */
  InstantApplied: 5,
  /** Recognised, but there is no seat to apply it to. */
  RefusedNoSeat: 6,
} as const;

export type CheatOutcomeId = (typeof CheatOutcome)[keyof typeof CheatOutcome];

/** One line for the player, beside the field they typed into. */
export function cheatOutcomeText(outcome: number): string {
  switch (outcome) {
    case CheatOutcome.Granted:
      return 'Code accepted.';
    case CheatOutcome.Revoked:
      return 'Code cleared.';
    case CheatOutcome.RefusedDisabled:
      return 'This server has cheats disabled.';
    case CheatOutcome.InstantApplied:
      return `${CHEAT_WALLET_KILLS} kills added to your killstreak balance.`;
    case CheatOutcome.RefusedNoSeat:
      return 'Not in a match.';
    default:
      return 'Unknown code.';
  }
}

/**
 * What an `'instant'` cheat's caption says while it is up.
 *
 * Derived from the code's own payload, so a second instant cheat gets a caption without anybody
 * writing one. Empty for a toggle, which has no announcement — it has a tag.
 */
export function instantCheatLabel(entry: CheatCode): string {
  return entry.effect.kind === 'instant' ? `+${entry.effect.kills} KILLS` : '';
}

/**
 * The HUD tag's whole text, or `''` for none. Rendered **by kind**.
 *
 * Two lifetimes in one string, and they compose rather than one hiding the other: the toggles are
 * on for as long as they are on, and an instant's announcement joins them for
 * `CHEAT_NOTICE_SECONDS`. Hiding `GOD` for four seconds to say `+30 KILLS` would take a standing
 * warning off screen to show a transient one, which is the wrong way round.
 *
 * `Cheat.Debug` is deliberately never named. Having the debug overlay unlocked says nothing about
 * the simulation, and a warning that is up for most of a developer's session stops being one.
 */
export function cheatCaption(mask: number, instantLabel: string): string {
  const parts: string[] = [];
  if ((mask & Cheat.God) !== 0) parts.push('GOD');
  if ((mask & Cheat.Unseen) !== 0) parts.push('UNSEEN');
  if ((mask & Cheat.NoClip) !== 0) parts.push('NOCLIP');
  if (instantLabel !== '') parts.push(instantLabel);
  return parts.length === 0 ? '' : `CHEATS · ${parts.join(' · ')}`;
}

/** One line for a log, including the debug bit. Never empty, so a revoke logs something. */
export function describeCheatMask(mask: number): string {
  if (mask === 0) return 'none';
  const parts: string[] = [];
  if ((mask & Cheat.God) !== 0) parts.push('god');
  if ((mask & Cheat.Unseen) !== 0) parts.push('unseen');
  if ((mask & Cheat.NoClip) !== 0) parts.push('noclip');
  return parts.join('+');
}

/**
 * What one seat is entitled to, as a thing an effect can hold a reference to.
 *
 * An interface rather than the class, so `NO_CHEATS` can be a shared frozen instance and a bot —
 * which has no session and can never be granted anything — costs nothing. Every effect takes one
 * of these; none of them takes a mask, because a number handed around is a number that gets
 * copied, and a copy is the second writer this whole file exists to avoid.
 */
export interface CheatGrants {
  readonly mask: number;
  has(bit: number): boolean;
}

/** A mutable set of grants. One per connection on the server; one per client. */
export class CheatState implements CheatGrants {
  private bits = 0;

  get mask(): number {
    return this.bits;
  }

  has(bit: number): boolean {
    return (this.bits & bit) !== 0;
  }

  /**
   * Replace the whole mask. The server's own writer, and the only one it needs.
   *
   * The server is the authority for its half and the sole owner of `Wallet`, so it has no
   * partition to respect — it *is* the partition's other side.
   */
  set(mask: number): void {
    this.bits = mask & 0xff;
  }

  clear(): void {
    this.bits = 0;
  }
}

/** Nothing, for ever. Bots, and any seat that has no connection behind it. */
export const NO_CHEATS: CheatGrants = {
  mask: 0,
  has: () => false,
};
