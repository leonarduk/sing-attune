import { describe, expect, it } from 'vitest';
import { getVisiblePartOptions, isAccompanimentPart } from './part-options';

describe('isAccompanimentPart', () => {
  it('matches common accompaniment aliases case-insensitively', () => {
    expect(isAccompanimentPart('Piano')).toBe(true);
    expect(isAccompanimentPart('Keyboard 1')).toBe(true);
    expect(isAccompanimentPart('Accomp Track')).toBe(true);
    expect(isAccompanimentPart('pno')).toBe(true);
    expect(isAccompanimentPart('KBD')).toBe(true);
  });

  it('does not classify vocal parts as accompaniment', () => {
    expect(isAccompanimentPart('Soprano')).toBe(false);
    expect(isAccompanimentPart('Alto')).toBe(false);
    expect(isAccompanimentPart('Tenor')).toBe(false);
    expect(isAccompanimentPart('Bass')).toBe(false);
  });
});

describe('getVisiblePartOptions', () => {
  it('hides accompaniment parts by default', () => {
    expect(getVisiblePartOptions(['Soprano', 'Piano'], false)).toEqual([
      { name: 'Soprano', hiddenByDefault: false },
    ]);
  });

  it('shows all parts when accompaniment is enabled', () => {
    expect(getVisiblePartOptions(['Soprano', 'Piano'], true)).toEqual([
      { name: 'Soprano', hiddenByDefault: false },
      { name: 'Piano', hiddenByDefault: true },
    ]);
  });

  it('falls back to all parts when every part is accompaniment', () => {
    expect(getVisiblePartOptions(['Piano', 'Keyboard'], false)).toEqual([
      { name: 'Piano', hiddenByDefault: true },
      { name: 'Keyboard', hiddenByDefault: true },
    ]);
  });
});
