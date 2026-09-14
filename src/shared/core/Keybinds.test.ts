import { describe, expect, it } from 'vitest';
import { Btn } from './InputCommand';
import { ACTIONS, defaultBindings, inputLabel, Keybinds, LocalBtn, normaliseBindings } from './Keybinds';

/**
 * Characterisation of the binding table: a `BindingMap` round-trips through `Keybinds`, a
 * physical input resolves to the bit its action carries and nothing else, rebinding steals,
 * and a save missing an action gets that action's defaults back.
 */

describe('BindingMap round-trip', () => {
  it('the defaults come back out of snapshot() unchanged, as a copy', () => {
    const kb = new Keybinds();
    const snap = kb.snapshot();
    expect(snap).toEqual(defaultBindings());
    snap.jump?.push('KeyJ');
    expect(kb.inputsFor('jump')).toEqual(['Space']);
  });

  it('a custom map survives set() -> snapshot() -> set()', () => {
    const custom = defaultBindings();
    custom.sprint = ['KeyE'];
    custom.use = ['KeyF'];
    custom.tactical = ['KeyH'];
    const a = new Keybinds(custom);
    const b = new Keybinds(a.snapshot());
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.inputsFor('sprint')).toEqual(['KeyE']);
    expect(b.bitsFor('KeyE')).toBe(Btn.Sprint);
  });
});

describe('bitsFor', () => {
  it('resolves every default input to its action\'s bit', () => {
    const kb = new Keybinds();
    for (const action of ACTIONS) {
      for (const input of action.defaults) expect(kb.bitsFor(input) & action.bit).toBe(action.bit);
    }
  });

  it('movement resolves to local bits above the wire, and an unbound input to 0', () => {
    const kb = new Keybinds();
    expect(kb.bitsFor('KeyW')).toBe(LocalBtn.Forward);
    expect(kb.bitsFor('KeyD')).toBe(LocalBtn.Right);
    expect(LocalBtn.Forward).toBeGreaterThan(0xffffff);
    expect(kb.bitsFor('KeyZ')).toBe(0);
  });

  it('ADS is the right mouse button, as the DOM numbers it', () => {
    const kb = new Keybinds();
    expect(kb.bitsFor('Mouse2')).toBe(Btn.Ads);
    expect(kb.bitsFor('Mouse1')).toBe(0);
    expect(inputLabel('Mouse2')).toBe('Right mouse');
    expect(inputLabel('Mouse1')).toBe('Middle mouse');
  });
});

describe('rebind', () => {
  it('steals the input from its previous owner and reports who that was', () => {
    const kb = new Keybinds();
    const { stolenFrom } = kb.rebind('sprint', 0, 'KeyE');
    expect(stolenFrom).toBe('use');
    expect(kb.inputsFor('sprint')).toEqual(['KeyE']);
    expect(kb.inputsFor('use')).toEqual(['KeyT']);
    expect(kb.bitsFor('KeyE')).toBe(Btn.Sprint);
  });

  it('collapses a duplicate on the same action', () => {
    const kb = new Keybinds();
    kb.rebind('crouch', 0, 'KeyC');
    expect(kb.inputsFor('crouch')).toEqual(['KeyC']);
  });

  it('clear() leaves an action legally unbound', () => {
    const kb = new Keybinds();
    kb.clear('jump', 0);
    expect(kb.inputsFor('jump')).toEqual([]);
    expect(kb.bitsFor('Space')).toBe(0);
    kb.resetToDefaults();
    expect(kb.inputsFor('jump')).toEqual(['Space']);
  });
});

describe('normaliseBindings', () => {
  it('a missing action gets its defaults; an empty list is kept as deliberately cleared', () => {
    const out = normaliseBindings({ jump: [], fire: ['Mouse0', 7, '', 'Mouse0'] });
    expect(out.jump).toEqual([]);
    expect(out.fire).toEqual(['Mouse0']);
    expect(out.streak1).toEqual(['Digit3']);
  });

  it('non-object input yields the defaults', () => {
    expect(normaliseBindings(null)).toEqual(defaultBindings());
    expect(normaliseBindings('KeyW')).toEqual(defaultBindings());
  });
});
