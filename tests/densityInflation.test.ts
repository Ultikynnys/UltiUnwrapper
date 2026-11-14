import { describe, expect, it } from 'vitest';
import { normalizeDensity } from '../src/lib/unwrap/density';
import { inflateDensity } from '../src/lib/unwrap/inflate';
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

describe('density inflation', () => {
  it('inflates low-density faces without shrinking dense ones', () => {
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
    const result = inflateDensity(mesh(), normalized, face, options);
    expect(result.stats.inflatedCharts).toBe(1);
    expect(result.stats.inflationIterations).toBeGreaterThan(0);
    expect(Number(result.stats.densityAfterSpread)).toBeLessThan(Number(result.stats.densityBeforeSpread));
    expect(result.faceTexelDensity[0]).toBeGreaterThan(4);
    expect(result.faceTexelDensity[1]).toBeGreaterThan(13);
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
    const result = inflateDensity(mesh, normalized, face, {
      atlasResolution: 2048,
      targetTexelDensity: 256,
    });
    expect(result.stats.inflatedCharts).toBe(0);
    expect(result.issues.some((issue) => issue.code === 'density-already-uniform')).toBe(true);
  });

  it('reports invalid inflation settings', () => {
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
    const result = inflateDensity(mesh, normalized, face, {
      atlasResolution: 0,
      targetTexelDensity: 0,
    });
    expect(result.issues.some((issue) => issue.code === 'invalid-density')).toBe(true);
  });
});
