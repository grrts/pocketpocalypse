import { describe, expect, it } from 'vitest';
import { Rng, hash2, hashString, fbm } from '../../src/core/rng';

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42), b = new Rng(42), c = new Rng(43);
    const sa = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(sa);
    expect(sa.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('hashes stably', () => {
    expect(hashString('w123')).toBe(hashString('w123'));
    expect(hashString('w123')).not.toBe(hashString('w124'));
    expect(hash2(1, 2, 3)).toBe(hash2(1, 2, 3));
    expect(hash2(1, 2, 3)).not.toBe(hash2(2, 1, 3));
  });

  it('keeps int() within bounds and fbm in 0..1', () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      const f = fbm(i * 0.37, i * 0.11, 9);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});
