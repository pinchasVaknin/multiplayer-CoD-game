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
 * `DEBUG666` changes a client surface and nothing else, so its bit is `CHEAT_LOCAL` and the
 * client authors it for itself. That is not a convenience: gating the debug overlay behind a
 * server flag would make it unreachable in single-player, where there is no server, and
 * unreachable against a deployed one — which is exactly where every "needs a browser" list in
 * PLAN.md asks somebody to go and read the NetPanel.
 *
 * The two masks are disjoint and every bit is in exactly one of them, which is what lets the
 * merge be one expression rather than a rule somebody has to remember (see `Game.cheatMask`).
 * `check-cheats.mjs` fails if a bit is in both or in neither.
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
 * | `Cheat.Debug` | toggle | **the session** — the tab | never granted server-side | retyping the code. Deliberately survives a migration and a rotation, exactly as `debugRequest` does |
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
 * **Every bit here is a state a player can be *in*.** F14 also gave a bit to the wallet payment,
 * as an attribution flag with no effect, and that was a modelling error this file had already
 * argued against two paragraphs further down: a payment is a transaction, and a transaction is
 * not a state. The bit outlived its own subject — the ledger row it described is destroyed by
 * the next migration — so the HUD went on claiming an audit trail for a balance that no longer
 * existed. Instant effects are announced (see `CheatKind`) rather than latched.
 */
export const Cheat = {
  /** The debug overlay is reachable. Client-authored; see the partition below. */
  Debug: 1 << 0,
  /** Takes no damage. `Damageable.invulnerable`, tested at the damage door. */
  God: 1 << 1,
  /** Nothing comes looking. `Combatant.participating`, tested by perception and spawn scoring. */
  Unseen: 1 << 2,
  /** Flies through the world. `PlayerController.noclip`. */
  NoClip: 1 << 3,
} as const;

export type CheatBit = (typeof Cheat)[keyof typeof Cheat];

/** The bits the simulation owns. Authored by the server, and by nobody else when there is one. */
export const CHEAT_SIMULATION = Cheat.God | Cheat.Unseen | Cheat.NoClip;

/** The bits a client may author for itself, because no simulation reads them. */
export const CHEAT_LOCAL = Cheat.Debug;

/** Everything `full spectator` means. See `SPEC[]4`. */
export const CHEAT_FULL_SPECTATOR = Cheat.God | Cheat.Unseen | Cheat.NoClip;

/**
 * Continuous or transient, **declared** rather than inferred at each reader.
 *
 * A `'toggle'` is a state a player is in until they leave it: it has a bit, it is replicated, and
 * the HUD shows it for as long as it is true. An `'instant'` is a transaction that is over the
 * moment it lands: it has no bit, nothing replicates it, and the HUD *announces* it for a fixed
 * display duration.
 *
 * It is a property of the code rather than a special case in the HUD, and that is the whole point
 * of the field. F14 rendered one persistent tag and gave the wallet payment a latched bit to be
 * rendered by, which put a receipt on screen for the rest of the session; the next instant cheat
 * would have repeated it. Keyed by kind, the next one is already handled.
 */
export type CheatKind = 'toggle' | 'instant';

/**
 * What a recognised code asks for. The discriminant is the kind above.
 *
 * A toggle carries the bits it flips. An instant carries its payload — today only `kills`, and a
 * second kind of payment would add a field here rather than a branch anywhere downstream.
 */
export type CheatEffect =
  | { readonly kind: 'toggle'; readonly bits: number }
  | { readonly kind: 'instant'; readonly kills: number };

/** A recognised code: what it is called, what it does, and who decides. */
export interface CheatCode {
  readonly code: string;
  readonly effect: CheatEffect;
  /**
   * True when the client may apply this to itself without asking anybody.
   *
   * Derived from the partition rather than stated per row, so a code whose bits are in
   * `CHEAT_SIMULATION` cannot be marked local by accident.
   */
  readonly local: boolean;
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
  { code: 'DEBUG666', effect: { kind: 'toggle', bits: Cheat.Debug }, local: true },
  { code: 'SPEC[]1', effect: { kind: 'toggle', bits: Cheat.God }, local: false },
  { code: 'SPEC[]2', effect: { kind: 'toggle', bits: Cheat.Unseen }, local: false },
  { code: 'SPEC[]3', effect: { kind: 'toggle', bits: Cheat.NoClip }, local: false },
  { code: 'SPEC[]4', effect: { kind: 'toggle', bits: CHEAT_FULL_SPECTATOR }, local: false },
  { code: 'MO951357', effect: { kind: 'instant', kills: CHEAT_WALLET_KILLS }, local: false },
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
 * what somebody reaching for one control wants, and it is now one function both surfaces call
 * instead of two that agree until they do not.
 */
export function toggleCheat(mask: number, bits: number): number {
  const all = (mask & bits) === bits;
  return all ? mask & ~bits : mask | bits;
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
  if ((mask & Cheat.Debug) !== 0) parts.push('debug');
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
