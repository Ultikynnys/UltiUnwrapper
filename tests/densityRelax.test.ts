import { describe, expect, it } from 'vitest';
import { normalizeDensity } from '../src/lib/unwrap/density';
import { relaxDensity } from '../src/lib/unwrap/relax';
import { conditionMesh, computeFaceGeometry } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import { segmentMesh } from '../src/lib/unwrap/charts';
import { parameterizeMesh } from '../src/lib/unwrap/parameterize';
import { makeCube } from './helpers/meshes';
import type {
  ChartUv,
  ConditionedMesh,
  ParameterizeResult,
} from '../src/lib/unwrap/types';

function chart(): ChartUv {
  return {
    chart: 0,
    triangles: new Uint32Array([0, 1]),
    localIndices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    localVertex: new Uint32Array([0, 1, 2, 3, 4, 5]),
    uvs: new Float32Array([
      0, 0, 1, 0, 1, 0.2,
      0, 0, 2, 0, 0, 1,
    ]),
    worldArea: 2,
    uvArea: 1.1,
    bbox: { minU: 0, minV: 0, maxU: 2, maxV: 1 },
    solverIterations: 0,
    solverResidual: 0,
    solverConverged: true,
    initialization: 'source',
    failed: false,
    failure: null,
  };
}

function mesh(): ConditionedMesh {
  return {
    positions: new Float32Array(18),
    normals: new Float32Array(18),
    indices: new Uint32Array(6),
    objectOfTriangle: new Uint32Array(2),
    materialOfTriangle: new Int32Array(2).fill(-1),
    sourceTriangle: new Uint32Array([0, 1]),
    sourceVertex: new Uint32Array(6),
    objectNames: ['test'],
    vertexCount: 6,
    triangleCount: 2,
  };
}

describe('density relax', () => {
  it('flocks low-density faces upward without shrinking dense ones', () => {
    const parameterization: ParameterizeResult = {
      charts: [chart()],
      triangleUvs: new Float32Array(12),
      angleDistortion: new Float32Array(2),
      areaDistortion: new Float32Array(2),
      flipped: new Uint8Array(2),
      stats: {},
      issues: [],
    };
    const face = {
      normals: new Float32Array([0, 0, 1, 0, 0, 1]),
      areas: new Float32Array([1, 1]),
    };
    const options = {
      atlasResolution: 10,
      targetTexelDensity: 10,
    };
    const normalized = normalizeDensity(mesh(), parameterization, face, options);
    const result = relaxDensity(mesh(), normalized, face, options);
    expect(result.stats.relaxedCharts).toBe(1);
    expect(result.stats.boidPasses).toBeGreaterThan(0);
    expect(Number(result.stats.densityAfterSpread)).toBeLessThan(Number(result.stats.densityBeforeSpread));
    expect(result.faceTexelDensity[0]).toBeGreaterThan(4);
    expect(result.faceTexelDensity[1]).toBeGreaterThan(13);
  });

  it('records the density difference after every boid pass', () => {
    const parameterization: ParameterizeResult = {
      charts: [chart()],
      triangleUvs: new Float32Array(12),
      angleDistortion: new Float32Array(2),
      areaDistortion: new Float32Array(2),
      flipped: new Uint8Array(2),
      stats: {},
      issues: [],
    };
    const face = {
      normals: new Float32Array([0, 0, 1, 0, 0, 1]),
      areas: new Float32Array([1, 1]),
    };
    const options = {
      atlasResolution: 10,
      targetTexelDensity: 10,
    };
    const normalized = normalizeDensity(mesh(), parameterization, face, options);
    const result = relaxDensity(mesh(), normalized, face, options);
    const history = result.relaxHistory ?? [];
    expect(history.length).toBeGreaterThan(1);
    expect(history.every((sample) => sample.chart === 0)).toBe(true);
    for (let index = 1; index < history.length; index += 1) {
      expect(history[index].difference).toBeLessThanOrEqual(history[index - 1].difference + 1e-7);
    }
    expect(history[history.length - 1].difference)
      .toBeLessThan(history[0].difference);
  });

  it('skips a chart with no triangles', () => {
    const empty = {
      ...chart(),
      triangles: new Uint32Array(),
      localIndices: new Uint32Array(),
      localVertex: new Uint32Array(),
      uvs: new Float32Array(),
      worldArea: 0,
      uvArea: 0,
    };
    const parameterization: ParameterizeResult = {
      charts: [empty],
      triangleUvs: new Float32Array(),
      angleDistortion: new Float32Array(),
      areaDistortion: new Float32Array(),
      flipped: new Uint8Array(),
      stats: {},
      issues: [],
    };
    const face = {
      normals: new Float32Array(),
      areas: new Float32Array(),
    };
    const options = {
      atlasResolution: 10,
      targetTexelDensity: 10,
    };
    const normalized = normalizeDensity(mesh(), parameterization, face, options);
    const result = relaxDensity(mesh(), normalized, face, options);
    expect(result.stats.relaxedCharts).toBe(0);
    expect(result.relaxHistory).toEqual([]);
  });

  it('stops when the expansion cap forbids any growth', () => {
    const parameterization: ParameterizeResult = {
      charts: [chart()],
      triangleUvs: new Float32Array(12),
      angleDistortion: new Float32Array(2),
      areaDistortion: new Float32Array(2),
      flipped: new Uint8Array(2),
      stats: {},
      issues: [],
    };
    const face = {
      normals: new Float32Array([0, 0, 1, 0, 0, 1]),
      areas: new Float32Array([1, 1]),
    };
    const options = {
      atlasResolution: 10,
      targetTexelDensity: 10,
      maxExpansion: 1,
      maxIterations: 1,
    };
    const normalized = normalizeDensity(mesh(), parameterization, face, options);
    const result = relaxDensity(mesh(), normalized, face, options);
    expect(result.stats.relaxedCharts).toBe(0);
    expect(result.relaxHistory).toEqual([]);
    expect(result.issues.some((issue) => issue.code === 'density-relax-blocked')).toBe(true);
  });

  it('reports a chart that cannot reach the average within its boid budget', () => {
    const parameterization: ParameterizeResult = {
      charts: [chart()],
      triangleUvs: new Float32Array(12),
      angleDistortion: new Float32Array(2),
      areaDistortion: new Float32Array(2),
      flipped: new Uint8Array(2),
      stats: {},
      issues: [],
    };
    const face = {
      normals: new Float32Array([0, 0, 1, 0, 0, 1]),
      areas: new Float32Array([1, 1]),
    };
    const options = {
      atlasResolution: 10,
      targetTexelDensity: 10,
      maxExpansion: 1.05,
      maxIterations: 1,
    };
    const normalized = normalizeDensity(mesh(), parameterization, face, options);
    const result = relaxDensity(mesh(), normalized, face, options);
    expect(result.stats.relaxedCharts).toBe(1);
    expect(result.issues.some((issue) => issue.code === 'density-relax-limited')).toBe(true);
  });

  it('reports a chart that is already at the average density', () => {
    const { mesh } = conditionMesh(makeCube(2));
    const topology = buildTopology(mesh);
    const face = computeFaceGeometry(mesh);
    const segmentation = segmentMesh(mesh, topology, face, {
      seamAngle: 66,
      splitByObject: true,
      splitByMaterial: false,
    });
    const parameterization = parameterizeMesh(mesh, segmentation, face, topology);
    const normalized = normalizeDensity(mesh, parameterization, face, {
      atlasResolution: 2048,
      targetTexelDensity: 256,
    });
    const result = relaxDensity(mesh, normalized, face, {
      atlasResolution: 2048,
      targetTexelDensity: 256,
    });
    expect(result.stats.relaxedCharts).toBe(0);
    expect(result.issues.some((issue) => issue.code === 'density-already-uniform')).toBe(true);
  });

  it('reports invalid relax settings', () => {
    const { mesh } = conditionMesh(makeCube(2));
    const topology = buildTopology(mesh);
    const face = computeFaceGeometry(mesh);
    const segmentation = segmentMesh(mesh, topology, face, {
      seamAngle: 66,
      splitByObject: true,
      splitByMaterial: false,
    });
    const parameterization = parameterizeMesh(mesh, segmentation, face, topology);
    const normalized = normalizeDensity(mesh, parameterization, face, {
      atlasResolution: 2048,
      targetTexelDensity: 256,
    });
    const result = relaxDensity(mesh, normalized, face, {
      atlasResolution: 0,
      targetTexelDensity: 0,
    });
    expect(result.issues.some((issue) => issue.code === 'invalid-density')).toBe(true);
  });
});
