import { describe, expect, it } from 'vitest';
import { rasterizeCoverage, rasterizeTriangles, uvToTexturePoint, type RasterTriangle } from '../src/lib/unwrap/raster';

const square: RasterTriangle[] = [
  { uv: [[0, 0], [1, 0], [1, 1]] },
  { uv: [[0, 0], [1, 1], [0, 1]] },
];

describe('UV rasterization', () => {
  it('maps UV corners into top-left texture space', () => {
    expect(uvToTexturePoint([0, 0], 100, 50)).toEqual([0, 50]);
    expect(uvToTexturePoint([1, 1], 100, 50)).toEqual([100, 0]);
  });

  it('covers the full atlas with a square', () => {
    const result = rasterizeCoverage(16, 8, square);
    expect(result.covered).toBe(128);
    expect(result.overlapping).toBe(0);
    expect(result.counts.every((value) => value === 1)).toBe(true);
  });

  it('counts overlapping copies', () => {
    const result = rasterizeCoverage(8, 8, [...square, ...square]);
    expect(result.covered).toBe(64);
    expect(result.overlapping).toBe(64);
    expect(result.counts.every((value) => value === 2)).toBe(true);
  });

  it('ignores degenerate triangles', () => {
    const result = rasterizeCoverage(8, 8, [{ uv: [[0, 0], [1, 0], [2, 0]] }]);
    expect(result.covered).toBe(0);
    expect(result.overlapping).toBe(0);
  });

  it('clips triangles to the atlas', () => {
    let count = 0;
    rasterizeTriangles(4, 4, [{ uv: [[-1, -1], [2, -1], [2, 2]] }], () => {
      count += 1;
    });
    expect(count).toBe(10);
  });
});
