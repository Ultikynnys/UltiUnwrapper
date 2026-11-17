import { describe, expect, it } from 'vitest';
import { conditionMesh, computeFaceGeometry } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import {
  buildSmartIslandBase,
  minimizeCharts,
  projectSmart,
} from '../src/lib/unwrap/smartProject';
import { prepareCutLayout, type RefineTaskInput } from '../src/lib/unwrap/refineTask';
import { createWasmRefiner } from '../src/lib/unwrap/refineWasm';
import { nowEpoch } from '../src/lib/unwrap/clock';
import { chartFaceDensities } from '../src/lib/unwrap/density';
import type { ChartUv } from '../src/lib/unwrap/types';
import { makeCube, makeSphere } from './helpers/meshes';

function prepareInput(kind: 'cube' | 'sphere'): RefineTaskInput {
  const raw = kind === 'cube' ? makeCube(2) : makeSphere(12, 6, 1);
  const { mesh } = conditionMesh(raw);
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

function assertDensity(charts: ChartUv[], input: RefineTaskInput): void {
  for (const chart of charts) {
    const densities = chartFaceDensities(chart, input.face, 1).filter((value) => value > 0);
    if (densities.length < 2) continue;
    const spread = Math.max(...densities) / Math.min(...densities) - 1;
    expect(spread).toBeLessThanOrEqual(input.tolerance + 1e-6);
  }
}

describe('WASM refinement', () => {
  for (const kind of ['cube', 'sphere'] as const) {
    it(`matches the JavaScript merge on a ${kind}`, async () => {
      const input = prepareInput(kind);
      const deadline = nowEpoch() + 5_000;
      const cut = prepareCutLayout(input, 0, deadline);
      const wasm = await createWasmRefiner(input, cut);
      try {
        const layout = wasm.run(0, deadline);
        const charts = wasm.materialize(layout);
        const js = minimizeCharts(
          cut.charts,
          input.mesh,
          input.face,
          input.topology,
          input.seamEdge,
          input.tolerance,
          deadline,
          input.mergeCos,
          input.axisMergeCos,
          0,
        );
        expect(layout.chartCount).toBe(charts.length);
        expect(charts.length).toBe(js.charts.length);
        expect(layout.merges).toBe(js.merges);
        expect(layout.boundaryEdges).toBe(js.boundaryEdges);
        expect(layout.timedOut).toBe(false);
        assertDensity(charts, input);
      } finally {
        wasm.dispose();
      }
    });
  }
});
