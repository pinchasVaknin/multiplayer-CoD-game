/**
 * An owner of subscriptions that end when it does (M14, Phase C, concern C2).
 *
 * ## The shape this replaces
 *
 * Seventeen classes across all three partitions carried the same three pieces by hand:
 *
 * ```ts
 * private readonly unsubscribe: Array<() => void> = [];
 * this.unsubscribe.push(bus.on(EV.X, ...));          // in the constructor or subscribe()
 * for (const off of this.unsubscribe) off();         // first thing in dispose()
 * this.unsubscribe.length = 0;
 * ```
 *
 * That is the teardown surface §4.18 names as the leak most likely to go unnoticed — *"a bus
 * that only grows is invisible until hour six"* — and `npm run leak` exists to catch it. The
 * three pieces change together (a class that gains a subscription must remember the list; a
 * class that gains a list must remember the drain), which is the Rule of Three met five times
 * over, so the list and the drain now live here once.
 *
 * ## Why a base class and not a `@disposable` decorator
 *
 * Both were designed. The decorator loses on three counts, each measured in the tree:
 * it has to wrap `dispose()` in one fixed order, and `StreakSystem` drains *after* `endAll()`
 * where the other sixteen drain first; it cannot give `own()` a type without an interface
 * merge on every class, so the list would be reached through an untyped field name; and a
 * decorator under `shared/combat` or `shared/ai` is refused by `check:decorators`, which
 * `ScoreSystem` and `BotDirector` sit in. A base class takes all seventeen: each subclass
 * calls `super.dispose()` where its drain was, the list is private here and reached only
 * through `own()`, and nothing on the tick path changes — a subclass's own methods stay on
 * its own prototype, and `own()` runs at subscribe time, once per match, not per tick.
 *
 * ## The contract
 *
 * `own(off)` takes an unsubscriber and keeps it. `dispose()` calls every kept unsubscriber in
 * the order they were taken, then forgets them; a subclass that overrides `dispose()` must
 * call `super.dispose()`, and the place it does so is the place its drain used to be. Nothing
 * here throws and nothing here is new: `npm run leak` is the gate that proves the drain still
 * mirrors every subscription, exactly as it did when the lines were written out by hand.
 */
export abstract class Disposable {
  private readonly subscriptions: Array<() => void> = [];

  /**
   * Keep one or more unsubscribers for `dispose()` to call. Variadic because `push` was, and
   * one class (`MatchLedger`) takes its seven in a single call; the rest array is allocated at
   * subscribe time, once per owner, never per tick.
   */
  protected own(...offs: Array<() => void>): void {
    for (const off of offs) this.subscriptions.push(off);
  }

  /** Release every subscription taken through `own()`, in the order they were taken. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }
}
