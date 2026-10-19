import { describe, expect, it } from 'vitest';
import { Juice } from '../../src/game/juice';

describe('juice', () => {
  it('hit-stop never stacks past a few frames', () => {
    const j = new Juice();
    for (let i = 0; i < 10; i++) j.stop(0.06);
    expect(j.hitstop).toBeLessThanOrEqual(0.09);
    j.update(0.016, 0.1, Math.random);
    expect(j.hitstop).toBe(0);
  });

  it('counts a kill streak and lets it lapse', () => {
    const j = new Juice();
    j.kill();
    j.kill();
    j.kill();
    expect(j.streak).toBe(3);
    j.update(0.5, 3.1, Math.random);
    expect(j.streak).toBe(0);
    expect(j.bestStreak).toBe(3);
  });

  it('gore lands as blood that stays on the ground', () => {
    const j = new Juice();
    j.gore(0, 0, 1, 0, Math.random, 10);
    for (let i = 0; i < 120; i++) j.update(1 / 60, 1 / 60, Math.random);
    expect(j.parts.length).toBe(0);
    expect(j.splats.length).toBeGreaterThan(5);
    expect(Math.max(...j.splats.map((s) => s.life))).toBeGreaterThan(30);
  });
});
