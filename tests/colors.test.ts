import { describe, expect, it } from 'vitest';
import {
  chartColor,
  chartColorCss,
  densityColor,
  heatColor,
  mix,
  rgbCss,
} from '../src/lib/unwrap/colors';

describe('chart colors', () => {
  it('walks hues deterministically and emits CSS', () => {
    const first = chartColor(0);
    const second = chartColor(1);
    expect(first).not.toEqual(second);
    expect(first.every((value) => value >= 0 && value <= 255)).toBe(true);
    expect(chartColorCss(3)).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
  });
});

describe('color mixing', () => {
  it('mixes and clamps two colors', () => {
    expect(mix([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
    expect(mix([10, 20, 30], [110, 120, 130], -1)).toEqual([10, 20, 30]);
    expect(mix([10, 20, 30], [110, 120, 130], 2)).toEqual([110, 120, 130]);
    expect(rgbCss([1, 2, 3])).toBe('rgb(1 2 3)');
  });
});

describe('metric ramps', () => {
  it('clamps the heat ramp at both ends', () => {
    expect(heatColor(0, 30)).toEqual([38, 93, 171]);
    expect(heatColor(-10, 30)).toEqual([38, 93, 171]);
    expect(heatColor(30, 30)).toEqual([215, 48, 39]);
    expect(heatColor(90, 30)).toEqual([215, 48, 39]);
    expect(heatColor(15, 30)).not.toEqual(heatColor(0, 30));
    expect(heatColor(0, 0)).toEqual([38, 93, 171]);
  });

  it('maps density ratios below, at, and above target', () => {
    const green = densityColor(1);
    expect(green[1]).toBeGreaterThan(green[0]);
    expect(densityColor(0.5)).toEqual([225, 80, 72]);
    expect(densityColor(1.5)).toEqual([72, 120, 220]);
    expect(densityColor(0)).toEqual([225, 80, 72]);
    expect(densityColor(2)).toEqual([72, 120, 220]);
  });
});
