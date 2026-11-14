import { describe, expect, it } from 'vitest';
import { computeFaceGeometry, conditionMesh } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import { segmentMesh } from '../src/lib/unwrap/charts';
import { parameterizeMesh } from '../src/lib/unwrap/parameterize';
import { percentile, signedTriangleArea2D, summarize } from '../src/lib/unwrap/metrics';
import { solveConjugateGradient } from '../src/lib/unwrap/solver';
import { solveLscm, type LscmTriangle } from '../src/lib/unwrap/lscm';
import type { RawMesh } from '../src/lib/unwrap/types';
import { makeCube, makeCylinder, makePlaneGrid, makeSphere } from './helpers/meshes';

function parameterize(raw: RawMesh) {
  const { mesh } = conditionMesh(raw);
  const topology = buildTopology(mesh);
  const face = computeFaceGeometry(mesh);
  const segmentation = segmentMesh(mesh, topology, face, {
    seamAngle: 66,
    splitByObject: true,
    splitByMaterial: false,
  });
  const result = parameterizeMesh(mesh, segmentation, face, topology);
  return { mesh, face, segmentation, result };
}

function triangleUvArea(triangleUvs: Float32Array): number {
  let area = 0;
  for (let triangle = 0; triangle < triangleUvs.length / 6; triangle += 1) {
    area += Math.abs(signedTriangleArea2D(
      triangleUvs[triangle * 6],
      triangleUvs[triangle * 6 + 1],
      triangleUvs[triangle * 6 + 2],
      triangleUvs[triangle * 6 + 3],
      triangleUvs[triangle * 6 + 4],
      triangleUvs[triangle * 6 + 5],
    ));
  }
  return area;
}

describe('percentiles and areas', () => {
  it('interpolates percentiles and summarizes values', () => {
    expect(percentile([0, 1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([0, 1, 2, 3, 4], 0.95)).toBeCloseTo(3.8, 6);
    expect(percentile([0, 1, 2], 0)).toBe(0);
    expect(percentile([0, 1, 2], 1)).toBe(2);
    expect(percentile([], 0.5)).toBe(0);
    const summary = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(summary.min).toBe(2);
    expect(summary.max).toBe(9);
    expect(summary.mean).toBe(5);
    expect(summary.p50).toBeCloseTo(4.5, 6);
    expect(summary.p95).toBeCloseTo(8.3, 6);
    expect(summarize([])).toEqual({ min: 0, p50: 0, p95: 0, max: 0, mean: 0 });
  });

  it('uses the right-hand rule for signed UV area', () => {
    expect(signedTriangleArea2D(0, 0, 1, 0, 0, 1)).toBeCloseTo(0.5, 12);
    expect(signedTriangleArea2D(0, 0, 0, 1, 1, 0)).toBeCloseTo(-0.5, 12);
  });
});

describe('conjugate gradient', () => {
  it('solves a small SPD system', () => {
    const size = 2;
    const matrix = [4, 1, 1, 3];
    const result = solveConjugateGradient(
      {
        size,
        diagonal: Float64Array.from([matrix[0], matrix[3]]),
        apply(x, out) {
          out[0] = matrix[0] * x[0] + matrix[1] * x[1];
          out[1] = matrix[2] * x[0] + matrix[3] * x[1];
        },
      },
      Float64Array.from([1, 2]),
      Float64Array.from([0, 0]),
      { tolerance: 1e-12, maxIterations: 10 },
    );
    expect(result.converged).toBe(true);
    expect(result.x[0]).toBeCloseTo(1 / 11, 9);
    expect(result.x[1]).toBeCloseTo(7 / 11, 9);
    expect(result.iterations).toBeGreaterThan(0);
  });

  it('handles zero right-hand sides and rejected singular systems', () => {
    const system = {
      size: 2,
      diagonal: Float64Array.from([1, 1]),
      apply(x: Float64Array, out: Float64Array) {
        out[0] = x[0];
        out[1] = x[1];
      },
    };
    const zero = solveConjugateGradient(
      system,
      Float64Array.from([0, 0]),
      Float64Array.from([1, 2]),
      { tolerance: 1e-12, maxIterations: 10 },
    );
    expect(zero.converged).toBe(true);
    expect(zero.iterations).toBe(0);
    expect(() => solveConjugateGradient(
      system,
      Float64Array.from([1]),
      Float64Array.from([1, 2]),
      { tolerance: 1e-12, maxIterations: 10 },
    )).toThrow(/do not match/);
    const broken = solveConjugateGradient(
      {
        size: 2,
        diagonal: Float64Array.from([1, 1]),
        apply(x: Float64Array, out: Float64Array) {
          out[0] = Number.NaN;
          out[1] = x[1];
        },
      },
      Float64Array.from([1, 1]),
      Float64Array.from([0, 0]),
      { tolerance: 1e-12, maxIterations: 5 },
    );
    expect(broken.converged).toBe(false);
    expect(broken.residual).toBe(Infinity);
  });
});

describe('LSCM', () => {
  it('flattens a square with two pinned corners', () => {
    const projected = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const triangles: LscmTriangle[] = [
      { a: 0, b: 1, c: 2, ax: 0, ay: 0, bx: 1, by: 0, cx: 1, cy: 1 },
      { a: 0, b: 2, c: 3, ax: 0, ay: 0, bx: 1, by: 1, cx: 0, cy: 1 },
    ];
    const result = solveLscm(4, triangles, projected, 0, 2);
    expect(result.converged).toBe(true);
    expect(Array.from(result.uvs).every((value) => Number.isFinite(value))).toBe(true);
    expect(signedTriangleArea2D(
      result.uvs[0], result.uvs[1],
      result.uvs[2], result.uvs[3],
      result.uvs[4], result.uvs[5],
    )).toBeGreaterThan(0);
  });
});

describe('parameterization', () => {
  it('copies planar cube faces without a solve', () => {
    const { result, mesh } = parameterize(makeCube(2));
    expect(result.charts).toHaveLength(6);
    expect(result.stats.angleP95).toBeLessThan(0.001);
    expect(result.stats.areaP95).toBeLessThan(0.001);
    expect(result.stats.flipped).toBe(0);
    expect(result.stats.fallbackCharts).toBe(0);
    expect(result.charts.every((chart) => chart.solverIterations === 0)).toBe(true);
    expect(result.charts.every((chart) => chart.fallback === false)).toBe(true);
    expect(triangleUvArea(result.triangleUvs)).toBeCloseTo(24, 5);
    for (const chart of result.charts) {
      expect(chart.uvArea).toBeCloseTo(4, 6);
      expect(chart.bbox.maxU).toBeCloseTo(2, 6);
      expect(chart.bbox.maxV).toBeCloseTo(2, 6);
      expect(Array.from(chart.uvs).every((value) => Number.isFinite(value))).toBe(true);
    }
    expect(mesh.triangleCount).toBe(12);
  });

  it('flattens an open plane exactly', () => {
    const { result } = parameterize(makePlaneGrid(2, 2));
    expect(result.charts).toHaveLength(1);
    expect(result.charts[0].fallback).toBe(false);
    expect(result.stats.angleP95).toBeLessThan(0.001);
    expect(result.charts[0].uvArea).toBeCloseTo(4, 6);
    expect(Math.max(result.charts[0].bbox.maxU, result.charts[0].bbox.maxV)).toBeGreaterThan(2);
  });

  it('unrolls the curved cylinder side with low distortion', () => {
    const { result } = parameterize(makeCylinder(12, 1, 2));
    expect(result.charts).toHaveLength(3);
    const side = result.charts.reduce((largest, chart) => (
      chart.triangles.length > largest.triangles.length ? chart : largest
    ));
    expect(side.triangles.length).toBe(24);
    expect(side.solverIterations).toBeGreaterThan(0);
    expect(side.solverConverged).toBe(true);
    expect(side.fallback).toBe(false);
    expect(result.stats.angleP95).toBeLessThan(5);
    expect(result.stats.flipped).toBe(0);
    expect(triangleUvArea(result.triangleUvs)).toBeGreaterThan(10);
  });

  it('produces a finite cut-sphere layout', () => {
    const { result } = parameterize(makeSphere(12, 6, 1));
    expect(result.charts).toHaveLength(1);
    expect(result.charts[0].fallback === true || result.charts[0].solverIterations > 0).toBe(true);
    expect(Array.from(result.triangleUvs).every((value) => Number.isFinite(value))).toBe(true);
    expect(result.charts[0].uvArea).toBeGreaterThan(0);
    expect(Number.isFinite(result.stats.angleP95)).toBe(true);
    expect(result.charts[0].bbox.maxU).toBeGreaterThan(0);
    expect(result.charts[0].bbox.maxV).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const first = parameterize(makeCylinder(16, 1, 2)).result;
    const second = parameterize(makeCylinder(16, 1, 2)).result;
    expect(Array.from(second.triangleUvs)).toEqual(Array.from(first.triangleUvs));
    expect(second.stats.angleP95).toBe(first.stats.angleP95);
  });

  it('selects pins for charts larger than the exhaustive threshold', () => {
    const { result } = parameterize(makeCylinder(140, 1, 2));
    const side = result.charts.reduce((largest, chart) => (
      chart.triangles.length > largest.triangles.length ? chart : largest
    ));
    expect(side.localVertex.length).toBeGreaterThan(256);
    expect(side.fallback).toBe(false);
    expect(side.solverIterations).toBeGreaterThan(0);
    expect(Array.from(result.triangleUvs).every((value) => Number.isFinite(value))).toBe(true);
  });
});
