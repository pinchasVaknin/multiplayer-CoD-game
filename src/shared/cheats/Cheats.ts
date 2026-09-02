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
 * ## Why `shared/`
 *
 * The same reason `HudSurfaces` and `pickSpectatorTarget` are here: the server parses codes and
 * the client parses codes, and two spellings of "SPEC[]4 means all three" is two places to get
 * it wrong. Nothing here touches the DOM.
 */

/**
 * One entitlement per bit. The mask crosses the wire as a single byte.
 *
 * `Wallet` is deliberately an entitlement with **no effect**. It records that this seat's
 * killstreak balance contains kills nobody scored, so a future bug report can be attributed —
 * "was this player in a normal state" is otherwise unanswerable, and a wallet grant leaves no
 * other trace on screen. See `MO951357` below.
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
  /** This seat's streak balance includes granted kills. Attribution only, no effect. */
  Wallet: 1 << 4,
} as const;

export type CheatBit = (typeof Cheat)[keyof typeof Cheat];

/**
 * The bits the simulation owns. Authored by the server, and by nobody else when there is one.
 *
 * `Wallet` is in here because the grant it records is a server decision even though the bit
 * itself drives nothing: a client that could set it would be claiming an audit trail it had
 * written itself, which is worse than having none.
 */
export const CHEAT_SIMULATION = Cheat.God | Cheat.Unseen | Cheat.NoClip | Cheat.Wallet;

/** The bits a client may author for itself, because no simulation reads them. */
export const CHEAT_LOCAL = Cheat.Debug;

/** Everything `full spectator` means. See `SPEC[]4`. */
export const CHEAT_FULL_SPECTATOR = Cheat.God | Cheat.Unseen | Cheat.NoClip;

/**
 * What a recognised code asks for.
 *
 * `toggle` is a mask to flip; `kills` is a one-shot payment. They are different kinds of thing
 * and the type says so — a wallet top-up is a transaction, not a state anybody can be *in*, and
 * modelling it as an entitlement would have meant a bit that means "has been paid", which is
 * true forever and pays only once.
 */
export type CheatEffect =
  | { readonly kind: 'toggle'; readonly bits: number }
  | { readonly kind: 'kills'; readonly kills: number };

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
  { code: 'MO951357', effect: { kind: 'kills', kills: CHEAT_WALLET_KILLS }, local: false },
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
  /** `MO951357` paid out. */
  WalletGranted: 5,
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
    case CheatOutcome.WalletGranted:
      return `${CHEAT_WALLET_KILLS} kills added to your killstreak balance.`;
    case CheatOutcome.RefusedNoSeat:
      return 'Not in a match.';
    default:
      return 'Unknown code.';
  }
}

/**
 * The HUD tag's text for a mask, or `''` for none.
 *
 * Named here rather than in the HUD because the words are about the entitlements and the HUD's
 * business is only whether to show them. `Wallet` is listed with the rest precisely because it
 * has no other symptom — a player with thirty free kills looks exactly like a player having a
 * good match.
 */
export function describeCheats(mask: number): string {
  if ((mask & ~Cheat.Debug) === 0) return '';
  const parts: string[] = [];
  if ((mask & Cheat.God) !== 0) parts.push('GOD');
  if ((mask & Cheat.Unseen) !== 0) parts.push('UNSEEN');
  if ((mask & Cheat.NoClip) !== 0) parts.push('NOCLIP');
  if ((mask & Cheat.Wallet) !== 0) parts.push('WALLET');
  return `CHEATS · ${parts.join(' · ')}`;
}

/** One line for a log, including the debug bit. Never empty, so a revoke logs something. */
export function describeCheatMask(mask: number): string {
  if (mask === 0) return 'none';
  const parts: string[] = [];
  if ((mask & Cheat.Debug) !== 0) parts.push('debug');
  if ((mask & Cheat.God) !== 0) parts.push('god');
  if ((mask & Cheat.Unseen) !== 0) parts.push('unseen');
  if ((mask & Cheat.NoClip) !== 0) parts.push('noclip');
  if ((mask & Cheat.Wallet) !== 0) parts.push('wallet');
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
