import { describe, expect, it } from 'vitest';
import { conditionMesh, computeFaceGeometry } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import { buildSmartIslands, fitSmartIslands, projectSmart, SMART_FIT_AREA_TARGET } from '../src/lib/unwrap/smartProject';
import { chartFaceDensities } from '../src/lib/unwrap/density';
import { computeFaceMetrics } from '../src/lib/unwrap/metrics';
import type { ConditionedMesh, RawMesh } from '../src/lib/unwrap/types';
import { makeCube, makeCylinder, makePlaneGrid, makeSphere } from './helpers/meshes';

const options = { angleLimit: 66, areaWeight: 0 };

async function prepare(raw: RawMesh, maxDensitySpread?: number, budgetMs?: number) {
  const { mesh } = conditionMesh(raw);
  const topology = buildTopology(mesh);
  const face = computeFaceGeometry(mesh);
  const projection = projectSmart(mesh, face, options);
  const islands = await buildSmartIslands(mesh, topology, face, projection, {
    splitByObject: true,
    splitByMaterial: false,
    maxDensitySpread,
    budgetMs,
  });
  return { mesh, topology, face, projection, islands };
}

function withMaterials(raw: RawMesh, materials: number[]): RawMesh {
  return { ...raw, materialOfTriangle: Int32Array.from(materials) };
}

function extentOf(charts: Awaited<ReturnType<typeof buildSmartIslands>>['charts']): number {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const chart of charts) {
    for (let index = 0; index < chart.uvs.length; index += 2) {
      minU = Math.min(minU, chart.uvs[index]);
      minV = Math.min(minV, chart.uvs[index + 1]);
      maxU = Math.max(maxU, chart.uvs[index]);
      maxV = Math.max(maxV, chart.uvs[index + 1]);
    }
  }
  return Math.max(maxU - minU, maxV - minV);
}

describe('smart projection', () => {
  it('finds one projection per cube face and projects each face without flip', async () => {
    const { mesh, projection, islands, face } = await prepare(makeCube(2));
    expect(projection.projectionCount).toBe(6);
    expect(projection.stats.faces).toBe(mesh.triangleCount);
    expect(projection.stats.zeroAreaFaces).toBe(0);
    expect(projection.stats.projectionDotMin).toBeCloseTo(1, 6);
    expect(islands.charts).toHaveLength(6);
    expect(islands.chartOfTriangle).toHaveLength(mesh.triangleCount);
    for (const chart of islands.charts) {
      expect(chart.triangles).toHaveLength(2);
      expect(chart.uvArea).toBeCloseTo(4, 6);
      expect(chart.worldArea).toBeCloseTo(4, 6);
      expect(chart.initialization).toBe('projection');
      expect(chart.failed).toBe(false);
    }
    const metrics = computeFaceMetrics(mesh, islands.charts, islands.triangleUvs);
    expect(Array.from(metrics.flipped).every((value) => value === 0)).toBe(true);
    expect(face.areas.reduce((sum, value) => sum + value, 0)).toBeCloseTo(24, 6);
  });

  it('projects a plane into a single island that preserves area', async () => {
    const { projection, islands } = await prepare(makePlaneGrid(2, 2));
    expect(projection.projectionCount).toBe(1);
    expect(islands.charts).toHaveLength(1);
    expect(islands.charts[0].triangles).toHaveLength(8);
    expect(islands.charts[0].uvArea).toBeCloseTo(4, 6);
    expect(islands.charts[0].worldArea).toBeCloseTo(4, 6);
  });

  it('splits the cylinder into side caps and end caps', async () => {
    const { mesh, islands, projection } = await prepare(makeCylinder(12, 1, 2));
    expect(projection.projectionCount).toBeGreaterThan(2);
    expect(islands.charts.length).toBeGreaterThan(2);
    expect(islands.charts.length).toBeLessThanOrEqual(12);
    expect(islands.chartOfTriangle).toHaveLength(mesh.triangleCount);
    expect(islands.stats.islandSplits).toBeGreaterThan(0);
    const sizes = islands.charts.map((chart) => chart.triangles.length);
    expect(Math.max(...sizes)).toBe(12);
    const totalTriangles = sizes.reduce((sum, value) => sum + value, 0);
    expect(totalTriangles).toBe(mesh.triangleCount);
  });

  it('splits islands across material seams when requested', async () => {
    const plane = makePlaneGrid(2, 2);
    const materials = [0, 0, 1, 1, 0, 0, 1, 1];
    const raw = withMaterials(plane, materials);
    const { mesh } = conditionMesh(raw);
    const topology = buildTopology(mesh);
    const face = computeFaceGeometry(mesh);
    const projection = projectSmart(mesh, face, options);
    const split = await buildSmartIslands(mesh, topology, face, projection, {
      splitByObject: true,
      splitByMaterial: true,
    });
    const merged = await buildSmartIslands(mesh, topology, face, projection, {
      splitByObject: true,
      splitByMaterial: false,
    });
    expect(split.charts.length).toBe(2);
    expect(merged.charts.length).toBe(1);
    expect(split.stats.materialSeams).toBeGreaterThan(0);
  });

  it('scales all islands uniformly into a unit square', async () => {
    const { islands } = await prepare(makeCube(2));
    const fitted = fitSmartIslands(islands.charts, islands.triangleUvs);
    const totalArea = islands.charts.reduce((sum, chart) => sum + chart.uvArea, 0);
    const expected = Math.min(1 / extentOf(islands.charts), Math.sqrt(SMART_FIT_AREA_TARGET / totalArea));
    expect(fitted.scale).toBeCloseTo(expected, 6);
    expect(fitted.scale).toBeLessThan(1);
    expect(extentOf(fitted.charts)).toBeLessThanOrEqual(1 + 1e-9);
    for (let index = 0; index < fitted.charts.length; index += 1) {
      const before = islands.charts[index];
      const after = fitted.charts[index];
      expect(after.uvArea).toBeCloseTo(before.uvArea * fitted.scale * fitted.scale, 6);
      expect(after.initialization).toBe('projection');
    }
  });

  it('cuts islands until their texel density variation is bounded', async () => {
    const { face, islands } = await prepare(makeSphere(12, 6, 1), 0.1, 1000);
    expect(Number(islands.stats.densitySpreadBefore)).toBeGreaterThan(0.1);
    expect(Number(islands.stats.densityRounds)).toBeGreaterThan(0);
    expect(Number(islands.stats.densitySplits)).toBeGreaterThan(0);
    expect(islands.stats.densityUnresolved).toBe(0);
    expect(islands.charts.reduce((sum, chart) => sum + chart.triangles.length, 0))
      .toBe(islands.chartOfTriangle.length);
    for (const chart of islands.charts) {
      const densities = chartFaceDensities(chart, face, 1).filter((value) => value > 0);
      if (densities.length < 2) continue;
      const spread = Math.max(...densities) / Math.min(...densities) - 1;
      expect(spread).toBeLessThanOrEqual(0.1 + 1e-6);
    }
  });

  it('reports no projections when every face is below the area threshold', () => {
    const mesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      triangleCount: 1,
    } as unknown as ConditionedMesh;
    const face = {
      normals: new Float32Array([0, 0, 1]),
      areas: new Float32Array([0]),
    };
    const projection = projectSmart(mesh, face, options);
    expect(projection.projectionCount).toBe(0);
    expect(projection.stats.zeroAreaFaces).toBe(1);
    expect(projection.issues.some((issue) => issue.code === 'no-projections')).toBe(true);
  });
});
