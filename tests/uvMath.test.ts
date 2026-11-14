import { describe, expect, it } from 'vitest';
import { mirrorU } from '../src/lib/unwrap/uvMath';

describe('mirrorU', () => {
  it('negates U and preserves V', () => {
    const source = new Float32Array([1, 2, -3, 4, 0, 5]);
    const mirrored = mirrorU(source);
    expect(mirrored[0]).toBe(-1);
    expect(mirrored[1]).toBe(2);
    expect(mirrored[2]).toBe(3);
    expect(Math.abs(mirrored[4])).toBe(0);
    expect(mirrored[5]).toBe(5);
    expect(source[0]).toBe(1);
  });
});
