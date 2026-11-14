import { describe, expect, it } from 'vitest';
import { BASE_MAJOR, BASE_MINOR, versionFromCount } from '../scripts/build-version.mjs';

describe('build version', () => {
  it('starts at 0.1.0 before the first commit', () => {
    expect(versionFromCount(0)).toBe('0.1.0');
  });

  it('derives the patch from the commit count', () => {
    expect(versionFromCount(1)).toBe('0.1.1');
    expect(versionFromCount(42)).toBe('0.1.42');
  });

  it('uses an explicit base', () => {
    expect(BASE_MAJOR).toBe(0);
    expect(BASE_MINOR).toBe(1);
  });

  it('rejects invalid counts', () => {
    expect(() => versionFromCount(-1)).toThrow();
    expect(() => versionFromCount(1.5)).toThrow();
    expect(() => versionFromCount(Number.NaN)).toThrow();
  });
});
