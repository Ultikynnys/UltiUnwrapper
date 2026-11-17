import { describe, expect, it } from 'vitest';
import { conditionMesh, computeFaceGeometry } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import {
  buildSmartIslandBase,
  compactChartLayout,
  projectSmart,
  type RefineRunnerInput,
} from '../src/lib/unwrap/smartProject';
import {
  REFINE_STAGNATION_TASKS,
  runRefinePool,
  type RefineWorkerHandle,
} from '../src/lib/unwrap/refinePool';
import type { RefineTaskInput } from '../src/lib/unwrap/refineTask';
import type { RefineWorkerRequest, RefineWorkerResponse } from '../src/lib/unwrap/refineMessages';
import { nowEpoch } from '../src/lib/unwrap/clock';
import { makeCube } from './helpers/meshes';

function prepareInput(): RefineRunnerInput {
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
    topology,
    face,
    variants: [
      { id: 'test-a', label: 'test', base, cutStrategies: 5 },
      { id: 'test-b', label: 'test', base, cutStrategies: 5 },
    ],
    deadline: nowEpoch() + 500,
    budgetMs: 500,
  };
}

function taskInputFor(input: RefineRunnerInput): RefineTaskInput {
  const base = input.variants[0].base;
  return {
    mesh: input.mesh,
    face: input.face,
    topology: input.topology,
    seamEdge: base.seams.seamEdge,
    neighbors: base.neighbors,
    baseCharts: base.baseCharts,
    tolerance: base.tolerance,
    mergeCos: base.mergeCos,
    axisMergeCos: base.axisMergeCos,
    mirrorPlane: base.mirrorPlane,
  };
}

function resultFor(
  input: RefineTaskInput,
  request: Extract<RefineWorkerRequest, { type: 'task' }>,
  stall: boolean,
): RefineWorkerResponse {
  const layout = stall
    ? compactChartLayout(input.baseCharts.slice(0, 2), input.face)
    : compactChartLayout([input.baseCharts[0]], input.face);
  return {
    type: 'result',
    id: request.id,
    result: {
      strategy: request.strategy,
      seed: request.seed,
      cut: {
        charts: input.baseCharts,
        rounds: 0,
        splits: 0,
        unresolved: 0,
        spreadBefore: 0,
        spreadAfter: 0,
        timedOut: false,
      },
      merge: {
        layout,
        merges: stall ? 1 : 0,
        boundaryEdges: 0,
        timedOut: false,
        unresolved: 0,
      },
    },
  };
}

function fakeWorker(
  taskInput: RefineTaskInput,
  failOnTask: boolean,
  stall = false,
): { handle: RefineWorkerHandle; tasks: () => number } {
  let tasks = 0;
  let listener: ((message: RefineWorkerResponse) => void) | null = null;
  const send = (message: RefineWorkerResponse): void => {
    queueMicrotask(() => listener?.(message));
  };
  const handle: RefineWorkerHandle = {
    postMessage(request) {
      if (request.type === 'init') {
        send({ type: 'ready' });
        return;
      }
      if (request.type !== 'task') return;
      tasks += 1;
      if (failOnTask) {
        send({ type: 'error', id: request.id, message: 'worker failed' });
        return;
      }
      send(resultFor(taskInput, request, stall));
    },
    onMessage(next) {
      listener = next;
    },
    onError() {},
    terminate() {},
  };
  return { handle, tasks: () => tasks };
}

describe('refinement pool scheduling', () => {
  it('finishes when every worker is idle and the queue is empty', async () => {
    const input = prepareInput();
    const taskInput = taskInputFor(input);
    const workers = [fakeWorker(taskInput, false), fakeWorker(taskInput, false)];
    let next = 0;
    const outcome = await runRefinePool(input, {
      threads: 2,
      createWorker: async () => workers[next++ % workers.length].handle,
    });
    expect(workers[0].tasks()).toBeGreaterThan(0);
    expect(outcome.refineRestarts).toBeGreaterThanOrEqual(5);
    expect(outcome.layout.chartCount).toBe(1);
    expect(outcome.densityUnresolved).toBe(0);
    expect(outcome.strategyVariants).toBe(2);
    expect(outcome.strategyAttempts).toBe(10);
    expect(outcome.bestStrategy).toBeGreaterThanOrEqual(0);
  });

  it('stops after all strategies stagnate', async () => {
    const input = prepareInput();
    input.deadline = nowEpoch() + 10_000;
    input.budgetMs = 10_000;
    const taskInput = taskInputFor(input);
    const worker = fakeWorker(taskInput, false, true);
    const outcome = await runRefinePool(input, {
      threads: 1,
      createWorker: async () => worker.handle,
    });
    expect(outcome.refineStoppedEarly).toBe(true);
    expect(outcome.refineTimedOut).toBe(false);
    expect(outcome.strategyAttempts).toBe(10);
    expect(outcome.refineRestarts).toBeGreaterThan(REFINE_STAGNATION_TASKS);
  });

  it('rejects when a worker fails before producing a layout', async () => {
    const input = prepareInput();
    const taskInput = taskInputFor(input);
    const worker = fakeWorker(taskInput, true);
    await expect(runRefinePool(input, {
      threads: 1,
      createWorker: async () => worker.handle,
    })).rejects.toThrow(/worker failed/);
  });
});
