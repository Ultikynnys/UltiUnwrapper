import { describe, expect, it } from 'vitest';
import { conditionMesh, computeFaceGeometry } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import { buildSmartIslandBase, projectSmart } from '../src/lib/unwrap/smartProject';
import type { RefineWorkerInit } from '../src/lib/unwrap/refineMessages';
import {
  createRefineWorkerState,
  disposeRefineWorkerState,
  executeRefineWorkerTask,
  setRefineWorkerInput,
} from '../src/lib/unwrap/refineWorkerTask';
import { nowEpoch } from '../src/lib/unwrap/clock';
import { makeCube } from './helpers/meshes';

function prepareInput(): RefineWorkerInit {
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
    variants: [{ id: 'test', label: 'test', base, cutStrategies: 5 }],
  };
}

describe('refinement worker task', () => {
  it('runs the WASM backend and falls back to JavaScript on request', async () => {
    const input = prepareInput();
    const state = createRefineWorkerState();
    setRefineWorkerInput(state, input);
    const deadline = nowEpoch() + 5_000;
    try {
      const wasm = await executeRefineWorkerTask(state, {
        id: 1,
        strategy: 0,
        seed: 0,
        deadline,
      });
      expect(wasm.merge.backend).toBe('wasm');
      expect(wasm.merge.layout.chartCount).toBeGreaterThan(0);

      process.env.ULTIUNWRAPPER_DISABLE_REFINE_WASM = '1';
      const js = await executeRefineWorkerTask(state, {
        id: 2,
        strategy: 0,
        seed: 0,
        deadline,
      });
      expect(js.merge.backend).toBe('js');
      expect(js.merge.layout.chartCount).toBe(wasm.merge.layout.chartCount);
    } finally {
      delete process.env.ULTIUNWRAPPER_DISABLE_REFINE_WASM;
      disposeRefineWorkerState(state);
    }
  });

  it('rejects a task before initialization', async () => {
    const state = createRefineWorkerState();
    await expect(executeRefineWorkerTask(state, {
      id: 1,
      strategy: 0,
      seed: 0,
      deadline: nowEpoch() + 1_000,
    })).rejects.toThrow(/not initialized/);
  });
});
