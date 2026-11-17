import { describe, expect, it } from 'vitest';
import { alignChartsToAxes } from '../src/lib/unwrap/chartAlign';
import type { ChartUv } from '../src/lib/unwrap/types';

function rectangleChart(): ChartUv {
  const width = 2;
  const height = 1;
  const angle = Math.PI / 6;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const corners = [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ];
  const uvs = new Float32Array(corners.length * 2);
  for (let index = 0; index < corners.length; index += 1) {
    const [x, y] = corners[index];
    uvs[index * 2] = x * cosine - y * sine;
    uvs[index * 2 + 1] = x * sine + y * cosine;
  }
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let index = 0; index < uvs.length; index += 2) {
    minU = Math.min(minU, uvs[index]);
    maxU = Math.max(maxU, uvs[index]);
    minV = Math.min(minV, uvs[index + 1]);
    maxV = Math.max(maxV, uvs[index + 1]);
  }
  return {
    chart: 0,
    triangles: Uint32Array.from([0, 1]),
    localIndices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    localVertex: Uint32Array.from([0, 1, 2, 3]),
    uvs,
    worldArea: 2,
    uvArea: 2,
    bbox: { minU, minV, maxU, maxV },
    solverIterations: 0,
    solverResidual: 0,
    solverConverged: true,
    initialization: 'projection',
    failed: false,
    failure: null,
  };
}

describe('chart axis alignment', () => {
  it('rotates a chart to its smallest bounding box without changing area', () => {
    const chart = rectangleChart();
    const result = alignChartsToAxes([chart]);
    expect(result.rotated).toBe(1);
    expect(result.areaAfter).toBeLessThan(result.areaBefore);
    expect(result.charts[0].uvArea).toBe(chart.uvArea);
    const width = result.charts[0].bbox.maxU - result.charts[0].bbox.minU;
    const height = result.charts[0].bbox.maxV - result.charts[0].bbox.minV;
    expect(Math.max(width, height)).toBeCloseTo(2, 5);
    expect(Math.min(width, height)).toBeCloseTo(1, 5);
  });

  it('leaves an already axis-aligned chart unchanged', () => {
    const chart = rectangleChart();
    const axisAligned: ChartUv = {
      ...chart,
      uvs: Float32Array.from([-1, -0.5, 1, -0.5, 1, 0.5, -1, 0.5]),
      bbox: { minU: -1, minV: -0.5, maxU: 1, maxV: 0.5 },
    };
    const result = alignChartsToAxes([axisAligned]);
    expect(result.rotated).toBe(0);
    expect(result.areaAfter).toBeCloseTo(result.areaBefore, 6);
  });
});
