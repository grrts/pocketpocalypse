import { describe, expect, it } from 'vitest';
import { ITEMS, LOOT, rollLoot } from '../../src/game/items';

describe('loot', () => {
  it('rolls the same contents for the same container', () => {
    expect(rollLoot(1, 'w42:door0', 'house')).toEqual(rollLoot(1, 'w42:door0', 'house'));
  });

  it('only produces known items', () => {
    for (const type of Object.keys(LOOT)) {
      for (let i = 0; i < 50; i++) {
        for (const s of rollLoot(9, `${type}${i}`, type)) {
          expect(ITEMS[s.id], s.id).toBeDefined();
          expect(s.qty).toBeGreaterThan(0);
        }
      }
    }
  });

  it('finds less in picked-over areas', () => {
    const total = (sc: number) => Array.from({ length: 400 }, (_, i) => rollLoot(3, `c${i}`, 'house', sc).length).reduce((a, b) => a + b, 0);
    expect(total(1)).toBeLessThan(total(0));
  });
});
