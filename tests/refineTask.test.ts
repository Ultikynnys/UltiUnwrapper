import { describe, expect, it } from 'vitest';
import { conditionMesh, computeFaceGeometry } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import {
  buildSmartIslandBase,
  materializeChartLayout,
  projectSmart,
} from '../src/lib/unwrap/smartProject';
import {
  prepareCutLayout,
  runMergeTask,
  runRefineTask,
  strategyTarget,
  totalStrategies,
} from '../src/lib/unwrap/refineTask';
import type { RefineTaskInput } from '../src/lib/unwrap/refineTask';
import { nowEpoch } from '../src/lib/unwrap/clock';
import { makeCube } from './helpers/meshes';

function prepareInput(): RefineTaskInput {
  const { mesh } = conditionMesh(makeCube(2));
  const topology = buildTopology(mesh);
  const face = computeFaceGeometry(mesh);
  const projection = projectSmart(mesh, face, { angleLimit: 66, areaWeight: 0 });
  const base = buildSmartIslandBase(mesh, topology, face, projection, {
    splitByObject: true,
    splitByMaterial: false,
    maxDensitySpread: 0.1,
  });
  return {
    mesh,
    face,
    topology,
    seamEdge: base.seams.seamEdge,
    neighbors: base.neighbors,
    baseCharts: base.baseCharts,
    tolerance: base.tolerance,
    mergeCos: base.mergeCos,
    axisMergeCos: base.axisMergeCos,
  };
}

function chartSignature(charts: { triangles: Uint32Array; uvs: Float32Array }[]): string {
  return charts
    .map((chart) => `${Array.from(chart.triangles).join(',')}:${Array.from(chart.uvs).map((value) => value.toFixed(6)).join(',')}`)
    .join('|');
}

describe('refinement task', () => {
  it('maps global strategies to variant and cut indices', () => {
    const variants = [{ cutStrategies: 5 }, { cutStrategies: 6 }];
    expect(totalStrategies(variants)).toBe(11);
    expect(strategyTarget(variants, 0)).toEqual({ variantIndex: 0, cutStrategy: 0 });
    expect(strategyTarget(variants, 4)).toEqual({ variantIndex: 0, cutStrategy: 4 });
    expect(strategyTarget(variants, 5)).toEqual({ variantIndex: 1, cutStrategy: 0 });
    expect(strategyTarget(variants, 10)).toEqual({ variantIndex: 1, cutStrategy: 5 });
    expect(strategyTarget(variants, 11)).toBeNull();
    expect(strategyTarget(variants, -1)).toBeNull();
  });

  it('returns the same layout for the same strategy and seed', () => {
    const input = prepareInput();
    const deadline = nowEpoch() + 5_000;
    const first = runRefineTask(input, { strategy: 0, seed: 0, deadline });
    const second = runRefineTask(input, { strategy: 0, seed: 0, deadline });
    expect(first.cut.timedOut).toBe(false);
    expect(first.merge.timedOut).toBe(false);
    expect(first.cut.unresolved).toBe(0);
    expect(first.merge.unresolved).toBe(0);
    expect(chartSignature(materializeChartLayout(input.mesh, input.face, first.merge.layout))).toBe(chartSignature(materializeChartLayout(input.mesh, input.face, second.merge.layout)));
    expect(first.merge.merges).toBe(second.merge.merges);
    expect(first.merge.boundaryEdges).toBe(second.merge.boundaryEdges);
  });

  it('matches an explicitly prepared cut layout and merge pass', () => {
    const input = prepareInput();
    const deadline = nowEpoch() + 5_000;
    const cut = prepareCutLayout(input, 0, deadline);
    const merge = runMergeTask(input, cut.charts, 7, deadline);
    const task = runRefineTask(input, { strategy: 0, seed: 7, deadline });
    expect(chartSignature(materializeChartLayout(input.mesh, input.face, task.merge.layout))).toBe(chartSignature(materializeChartLayout(input.mesh, input.face, merge.layout)));
    expect(task.merge).toEqual(merge);
    expect(task.cut).toEqual(cut);
  });

  it('stops without merging when the deadline has already passed', () => {
    const input = prepareInput();
    const result = runRefineTask(input, {
      strategy: 0,
      seed: 0,
      deadline: nowEpoch() - 1,
    });
    expect(result.cut.timedOut).toBe(true);
    expect(result.merge.timedOut).toBe(true);
    expect(result.merge.merges).toBe(0);
    expect(result.merge.layout.chartCount).toBe(input.baseCharts.length);
  });
});
