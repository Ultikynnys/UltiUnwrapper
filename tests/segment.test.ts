import { describe, expect, it } from 'vitest';
import { computeFaceGeometry, conditionMesh } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import { segmentMesh, type SegmentOptions } from '../src/lib/unwrap/charts';
import type { RawMesh } from '../src/lib/unwrap/types';
import {
  makeCube,
  makeCylinder,
  makeNonManifold,
  makePlaneGrid,
  makeSphere,
  makeSplitCube,
  rawMesh,
} from './helpers/meshes';

const defaults: SegmentOptions = {
  seamAngle: 66,
  splitByObject: true,
  splitByMaterial: false,
};

function segment(raw: RawMesh, options: Partial<SegmentOptions> = {}) {
  const { mesh } = conditionMesh(raw);
  const topology = buildTopology(mesh);
  const face = computeFaceGeometry(mesh);
  return {
    mesh,
    topology,
    face,
    result: segmentMesh(mesh, topology, face, { ...defaults, ...options }),
  };
}

describe('chart segmentation', () => {
  it('splits a cube into six planar charts', () => {
    const { result, mesh } = segment(makeCube(2));
    expect(result.charts).toHaveLength(6);
    expect(result.stats.seamEdges).toBe(12);
    expect(result.stats.boundaryEdges).toBe(0);
    expect(result.stats.cutsAdded).toBe(0);
    expect(result.stats.closedChartsBeforeCuts).toBe(0);
    for (const chart of result.charts) {
      expect(chart.closed).toBe(false);
      expect(chart.triangles).toHaveLength(2);
      expect(chart.localVertex).toHaveLength(4);
      expect(chart.localIndices).toHaveLength(6);
      expect(chart.worldArea).toBeCloseTo(4, 6);
      for (const local of chart.localIndices) expect(local).toBeLessThan(4);
    }
    expect(mesh.triangleCount).toBe(12);
  });

  it('keeps an open plane as one chart with its boundary intact', () => {
    const { result } = segment(makePlaneGrid(2, 2));
    expect(result.charts).toHaveLength(1);
    const chart = result.charts[0];
    expect(chart.closed).toBe(false);
    expect(chart.boundaryEdges).toHaveLength(8);
    expect(chart.localVertex).toHaveLength(9);
    expect(chart.localIndices).toHaveLength(24);
  });

  it('separates a cylinder side from its two caps', () => {
    const { result } = segment(makeCylinder(12, 1, 2));
    expect(result.charts).toHaveLength(3);
    expect(result.stats.cutsAdded).toBe(0);
    const sizes = result.charts.map((chart) => chart.triangles.length).sort((a, b) => a - b);
    expect(sizes).toEqual([12, 12, 24]);
    expect(result.charts.every((chart) => !chart.closed)).toBe(true);
  });

  it('cuts a closed sphere open along a geodesic path', () => {
    const { result } = segment(makeSphere(12, 6, 1));
    expect(result.stats.closedChartsBeforeCuts).toBe(1);
    expect(result.stats.cutsAdded).toBeGreaterThan(0);
    expect(result.charts).toHaveLength(1);
    expect(result.charts[0].closed).toBe(false);
    expect(result.charts[0].boundaryEdges.length).toBeGreaterThan(0);
    expect(result.issues.some((issue) => issue.code === 'closed-charts-remain')).toBe(false);
  });

  it('cuts a cube open when the seam angle suppresses every edge seam', () => {
    const { result } = segment(makeCube(2), { seamAngle: 180 });
    expect(result.stats.closedChartsBeforeCuts).toBe(1);
    expect(result.stats.cutsAdded).toBeGreaterThan(0);
    expect(result.charts).toHaveLength(1);
    expect(result.charts[0].closed).toBe(false);
  });

  it('reports non-manifold edges as seams', () => {
    const { result } = segment(makeNonManifold());
    expect(result.stats.nonManifoldEdges).toBe(1);
    expect(result.charts).toHaveLength(3);
    expect(result.issues.some((issue) => issue.code === 'non-manifold-seams')).toBe(true);
  });

  it('rejoins split-face vertices into the same six charts', () => {
    const { result } = segment(makeSplitCube(2));
    expect(result.charts).toHaveLength(6);
    expect(result.stats.seamEdges).toBe(12);
  });

  it('respects object boundaries only when requested', () => {
    const raw = rawMesh(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0],
      [0, 1, 2, 1, 0, 3],
      ['A', 'B'],
    );
    raw.objectOfTriangle[1] = 1;
    expect(segment(raw, { splitByObject: true }).result.charts).toHaveLength(2);
    expect(segment(raw, { splitByObject: false }).result.charts).toHaveLength(1);
  });

  it('respects material boundaries only when requested', () => {
    const raw = rawMesh(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0],
      [0, 1, 2, 1, 0, 3],
    );
    raw.materialOfTriangle[0] = 0;
    raw.materialOfTriangle[1] = 1;
    expect(segment(raw, { splitByMaterial: true }).result.charts).toHaveLength(2);
    expect(segment(raw, { splitByMaterial: false }).result.charts).toHaveLength(1);
  });

  it('is deterministic across runs', () => {
    const first = segment(makeCylinder(16, 1, 3)).result;
    const second = segment(makeCylinder(16, 1, 3)).result;
    expect(second.charts.map((chart) => Array.from(chart.triangles)))
      .toEqual(first.charts.map((chart) => Array.from(chart.triangles)));
    expect(Array.from(second.chartOfTriangle)).toEqual(Array.from(first.chartOfTriangle));
  });
});
