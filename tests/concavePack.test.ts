import { describe, expect, it } from 'vitest';
import { packConcaveCharts } from '../src/lib/unwrap/concavePack';
import type { ChartUv } from '../src/lib/unwrap/types';

type ChartData = {
  uvs: number[];
  indices: number[];
  triangles: number[];
};

function addRect(data: ChartData, x0: number, y0: number, x1: number, y1: number): void {
  const base = data.uvs.length / 2;
  data.uvs.push(x0, y0, x1, y0, x1, y1, x0, y1);
  const triangle = data.triangles.length;
  data.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  data.triangles.push(triangle, triangle + 1);
}

function chart(id: number, data: ChartData, minU = 0, minV = 0, maxU = 0.5, maxV = 0.5): ChartUv {
  return {
    chart: id,
    triangles: new Uint32Array(data.triangles),
    localIndices: new Uint32Array(data.indices),
    localVertex: new Uint32Array(data.uvs.length / 2),
    uvs: new Float32Array(data.uvs),
    worldArea: 1,
    uvArea: 36,
    bbox: { minU, minV, maxU, maxV },
    solverIterations: 0,
    solverResidual: 0,
    solverConverged: true,
    initialization: 'source',
    failed: false,
    failure: null,
  };
}

function complementaryLs(): [ChartUv, ChartUv] {
  const first: ChartData = { uvs: [], indices: [], triangles: [] };
  addRect(first, 0, 0, 0.5, 0.1);
  addRect(first, 0, 0.1, 0.1, 0.4);

  const second: ChartData = { uvs: [], indices: [], triangles: [] };
  addRect(second, 0, 0.4, 0.5, 0.5);
  addRect(second, 0.4, 0.1, 0.5, 0.4);

  return [chart(0, first), chart(1, second)];
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

describe('concave packing', () => {
  it('overlaps chart bounds when their silhouettes are complementary', () => {
    const [first, second] = complementaryLs();
    const result = packConcaveCharts([first, second], {
      grid: 64,
      resolution: 64,
      padding: 0,
      allowRotation: true,
      scale: 1,
      fill: false,
    });
    expect(result).not.toBeNull();
    expect(result?.placements).toHaveLength(2);
    expect(overlaps(result!.placements[0], result!.placements[1])).toBe(true);
  });

  it('grows the packed layout to fill the working grid', () => {
    const [first, second] = complementaryLs();
    const packed = packConcaveCharts([first, second], {
      grid: 64,
      resolution: 64,
      padding: 0,
      allowRotation: true,
      scale: 1,
      fill: false,
    });
    const filled = packConcaveCharts([first, second], {
      grid: 64,
      resolution: 64,
      padding: 0,
      allowRotation: true,
      scale: 1,
      fill: true,
    });
    expect(filled).not.toBeNull();
    expect(filled!.scale).toBeGreaterThan(packed!.scale);
    expect(filled!.placements[0].width).toBeGreaterThan(packed!.placements[0].width);
  });

  it('reserves padding around every occupied texel', () => {
    const small: ChartData = {
      uvs: [0, 0, 0.1, 0, 0.1, 0.1, 0, 0.1],
      indices: [0, 1, 2, 0, 2, 3],
      triangles: [0, 1],
    };
    const first = chart(0, small, 0, 0, 0.1, 0.1);
    const second = chart(1, small, 0, 0, 0.1, 0.1);
    expect(packConcaveCharts([first, second], {
      grid: 6,
      resolution: 6,
      padding: 2,
      allowRotation: false,
      scale: 1,
      fill: false,
    })).toBeNull();
  });

  it('honors padding and rejects shapes that cannot fit the grid', () => {
    const [first, second] = complementaryLs();
    const padded = packConcaveCharts([first, second], {
      grid: 64,
      resolution: 64,
      padding: 4,
      allowRotation: true,
      scale: 1,
      fill: false,
    });
    expect(padded).not.toBeNull();
    const huge = chart(2, {
      uvs: [0, 0, 100, 0, 100, 100, 0, 100],
      indices: [0, 1, 2, 0, 2, 3],
      triangles: [0, 1],
    }, 0, 0, 100, 100);
    expect(packConcaveCharts([huge], {
      grid: 64,
      resolution: 64,
      padding: 0,
      allowRotation: false,
      scale: 1,
      fill: false,
    })).toBeNull();
  });
});
