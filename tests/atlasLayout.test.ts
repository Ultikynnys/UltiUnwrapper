import { describe, expect, it } from 'vitest';
import { layoutGallery, type ChartBox } from '../src/lib/atlasLayout';

function box(size: number): ChartBox {
  return { minU: 0, minV: 0, maxU: size, maxV: size };
}

describe('layoutGallery', () => {
  it('lays six charts into a tall panel without stacking them', () => {
    const layout = layoutGallery([box(1), box(1), box(1), box(1), box(1), box(1)], 342, 719);
    expect(layout.columns).toBe(2);
    expect(layout.rows).toBe(3);
    expect(layout.transforms).toHaveLength(6);
    expect(new Set(layout.transforms.map((transform) => transform.scale)).size).toBe(1);
  });

  it('keeps relative chart sizes under one shared scale', () => {
    const layout = layoutGallery([box(1), box(0.5)], 400, 400);
    const large = layout.transforms[0];
    const small = layout.transforms[1];
    expect(small.scale).toBe(large.scale);
    expect(0.5 * small.scale).toBeCloseTo(0.5 * large.scale, 10);
    expect(small.left).toBeGreaterThan(large.left);
  });

  it('returns no transforms for an empty chart set', () => {
    const layout = layoutGallery([], 320, 480);
    expect(layout.columns).toBe(0);
    expect(layout.rows).toBe(0);
    expect(layout.transforms).toEqual([]);
  });
});
