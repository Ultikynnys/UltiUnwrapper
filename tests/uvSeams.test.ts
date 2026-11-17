import { describe, expect, it } from 'vitest';
import { makePlaneGrid, makeSplitCube } from './helpers/meshes';
import { conditionMesh, computeFaceGeometry } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import { computeSeams } from '../src/lib/unwrap/seams';
import { segmentFromSeams } from '../src/lib/unwrap/charts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/lib/unwrap/config';
import { runUnwrap } from '../src/lib/unwrap/pipeline';
import type { RawMesh } from '../src/lib/unwrap/types';

function withUvIslands(): RawMesh {
  const base = makeSplitCube(2);
  const triangleUvs = new Float32Array(base.indices.length * 2);
  for (let triangle = 0; triangle < base.indices.length / 3; triangle += 1) {
    const face = Math.floor(triangle / 2);
    const second = triangle % 2 === 1;
    const corners = second
      ? [[0, 0], [1, 1], [0, 1]]
      : [[0, 0], [1, 0], [1, 1]];
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = triangle * 6 + corner * 2;
      triangleUvs[offset] = face * 0.2 + corners[corner][0] * 0.1;
      triangleUvs[offset + 1] = corners[corner][1] * 0.1;
    }
  }
  return { ...base, triangleUvs };
}

function withUnevenUvScale(segments = 10): RawMesh {
  const base = makePlaneGrid(segments, 2);
  const triangleUvs = new Float32Array(base.indices.length * 2);
  const warp = (value: number): number => {
    const t = (value + 1) / 2;
    return t + 0.35 * t * t;
  };
  for (let triangle = 0; triangle < base.indices.length / 3; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = base.indices[triangle * 3 + corner];
      const offset = (triangle * 3 + corner) * 2;
      triangleUvs[offset] = warp(base.positions[vertex * 3]);
      triangleUvs[offset + 1] = (base.positions[vertex * 3 + 2] + 1) / 2;
    }
  }
  return { ...base, triangleUvs };
}

const base = mergeConfig(DEFAULT_CONFIG, { method: 'lscm' });

describe('source UV seams', () => {
  it('marks UV discontinuities as seams and keeps the islands separate', () => {
    const raw = withUvIslands();
    const { mesh } = conditionMesh(raw);
    const topology = buildTopology(mesh);
    const face = computeFaceGeometry(mesh);
    const options = {
      seamAngle: 180,
      splitByObject: true,
      splitByMaterial: false,
    };
    const seams = computeSeams(mesh, topology, face, options);
    expect(seams.uvSeamCount).toBeGreaterThan(0);
    expect(seams.dihedralSeamCount).toBe(0);

    const withCounts = segmentFromSeams(mesh, topology, face, seams.seamEdge, options, seams);
    expect(withCounts.charts).toHaveLength(6);
    expect(withCounts.stats.uvSeams).toBeGreaterThan(0);

    const withoutCounts = segmentFromSeams(mesh, topology, face, seams.seamEdge, options);
    expect(withoutCounts.charts).toHaveLength(6);
  });

  it('preserves source UV charts unless a rewrap is requested', async () => {
    const raw = withUvIslands();
    const preserved = await runUnwrap(raw, base);
    expect(preserved.segmentation.charts).toHaveLength(6);
    expect(preserved.parameterization.stats.harmonicCharts).toBe(0);
    expect(preserved.parameterization.issues.some((issue) => issue.code === 'source-uvs-preserved')).toBe(true);
    expect(preserved.stages[2].stats.charts).toBe(6);

    const rewrapped = await runUnwrap(raw, base, { preserveSourceUvs: false });
    expect(rewrapped.parameterization.issues.some((issue) => issue.code === 'source-uvs-preserved')).toBe(false);
  });

  it('cuts source UV charts further when they miss the density budget', async () => {
    const raw = withUnevenUvScale();
    const result = await runUnwrap(raw, base);
    expect(result.parameterization.issues.some((issue) => issue.code === 'source-uvs-preserved')).toBe(true);
    expect(result.segmentation.charts.length).toBeGreaterThan(1);
    expect(Number(result.stages[1].stats.refineSeamsAdded)).toBeGreaterThan(0);
    expect(Number(result.stages[1].stats.refineRounds)).toBeGreaterThan(1);
    expect(result.parameterization.charts.some((chart) => chart.initialization !== 'source')).toBe(true);
  });
});
