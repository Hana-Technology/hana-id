// The EventEmitter-compatible emitter behind hana.on and hana.ethereum.on.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../src/client/emitter.ts';

type Events = { a: [number]; b: [] };

afterEach(() => {
  vi.useRealTimers();
});

describe('Emitter', () => {
  it('calls listeners in order with the arguments, and reports whether any ran', () => {
    const e = new Emitter<Events>();
    const seen: string[] = [];
    e.on('a', (n) => seen.push(`1:${n}`)).addListener('a', (n) => seen.push(`2:${n}`));
    expect(e.emit('a', 7)).toBe(true);
    expect(e.emit('b')).toBe(false);
    expect(seen).toEqual(['1:7', '2:7']);
    expect(e.listenerCount('a')).toBe(2);
  });

  it('once runs one time and can be removed by the original listener', () => {
    const e = new Emitter<Events>();
    const l = vi.fn();
    e.once('a', l);
    e.emit('a', 1);
    e.emit('a', 2);
    expect(l).toHaveBeenCalledTimes(1);
    const l2 = vi.fn();
    e.once('a', l2);
    e.removeListener('a', l2);
    e.emit('a', 3);
    expect(l2).not.toHaveBeenCalled();
  });

  it('removeListener and off remove one registration; removeAllListeners clears', () => {
    const e = new Emitter<Events>();
    const l = vi.fn();
    e.on('a', l).on('a', l);
    e.off('a', l);
    e.emit('a', 1);
    expect(l).toHaveBeenCalledTimes(1);
    e.on('b', l);
    e.removeAllListeners('a');
    expect(e.listenerCount('a')).toBe(0);
    expect(e.listenerCount('b')).toBe(1);
    e.removeAllListeners();
    expect(e.listenerCount('b')).toBe(0);
  });

  it('a throwing listener does not stop the others; its error is rethrown on a later task', () => {
    vi.useFakeTimers();
    const e = new Emitter<Events>();
    const after = vi.fn();
    e.on('a', () => {
      throw new Error('listener bug');
    });
    e.on('a', after);
    expect(() => e.emit('a', 1)).not.toThrow();
    expect(after).toHaveBeenCalled();
    expect(() => vi.runAllTimers()).toThrow('listener bug');
  });

  it('a listener removed during emit still runs for that emit (snapshot), not for the next', () => {
    const e = new Emitter<Events>();
    const second = vi.fn();
    e.on('a', () => e.removeListener('a', second));
    e.on('a', second);
    e.emit('a', 1);
    e.emit('a', 2);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
