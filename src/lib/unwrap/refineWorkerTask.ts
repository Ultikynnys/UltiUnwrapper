import {
  prepareCutLayout,
  runRefineTask,
  strategyTarget,
  totalStrategies,
  type CutLayout,
  type RefineTaskInput,
  type RefineTaskResult,
} from './refineTask';
import type { RefineWorkerInit } from './refineMessages';
import { createWasmRefiner, type WasmRefiner } from './refineWasm';

export type RefineWorkerState = {
  init: RefineWorkerInit | null;
  inputs: RefineTaskInput[];
  /** Strategy index to (variant input, local cut strategy). */
  strategies: Array<{ input: RefineTaskInput; cutStrategy: number }>;
  cuts: Map<number, CutLayout>;
  refiners: Map<number, WasmRefiner>;
  wasmDisabled: boolean;
};

export type RefineWorkerTask = {
  id: number;
  strategy: number;
  seed: number;
  deadline: number;
};

function taskInput(init: RefineWorkerInit, variantIndex: number): RefineTaskInput {
  const variant = init.variants[variantIndex];
  return {
    mesh: init.mesh,
    face: init.face,
    topology: init.topology,
    seamEdge: variant.base.seams.seamEdge,
    neighbors: variant.base.neighbors,
    baseCharts: variant.base.baseCharts,
    tolerance: variant.base.tolerance,
    mergeCos: variant.base.mergeCos,
    axisMergeCos: variant.base.axisMergeCos,
    mirrorPlane: variant.base.mirrorPlane,
  };
}

export function createRefineWorkerState(): RefineWorkerState {
  return {
    init: null,
    inputs: [],
    strategies: [],
    cuts: new Map(),
    refiners: new Map(),
    wasmDisabled: false,
  };
}

export function disposeRefineWorkerState(state: RefineWorkerState): void {
  for (const refiner of state.refiners.values()) refiner.dispose();
  state.refiners.clear();
  state.cuts.clear();
  state.inputs = [];
  state.strategies = [];
  state.init = null;
}

export function setRefineWorkerInput(
  state: RefineWorkerState,
  init: RefineWorkerInit,
): void {
  disposeRefineWorkerState(state);
  state.init = init;
  state.inputs = init.variants.map((_, index) => taskInput(init, index));
  const count = totalStrategies(init.variants);
  for (let strategy = 0; strategy < count; strategy += 1) {
    const target = strategyTarget(init.variants, strategy);
    if (!target) break;
    state.strategies.push({
      input: state.inputs[target.variantIndex],
      cutStrategy: target.cutStrategy,
    });
  }
}

export async function executeRefineWorkerTask(
  state: RefineWorkerState,
  task: RefineWorkerTask,
): Promise<RefineTaskResult> {
  const mapping = state.strategies[task.strategy];
  if (!mapping) throw new Error('Refinement worker was not initialized.');
  const { input, cutStrategy } = mapping;
  const disableWasm = typeof process !== 'undefined'
    && process.env?.ULTIUNWRAPPER_DISABLE_REFINE_WASM === '1';
  let cut = state.cuts.get(task.strategy);
  if (!cut) {
    cut = prepareCutLayout(input, cutStrategy, task.deadline);
    if (!cut.timedOut) state.cuts.set(task.strategy, cut);
  }
  const spec = {
    strategy: task.strategy,
    seed: task.seed,
    deadline: task.deadline,
  };
  if (cut.timedOut || cut.unresolved > 0) {
    return runRefineTask(input, spec, cut);
  }

  if (!state.wasmDisabled && !disableWasm) {
    let refiner = state.refiners.get(task.strategy);
    if (!refiner) {
      try {
        refiner = await createWasmRefiner(input, cut);
        state.refiners.set(task.strategy, refiner);
      } catch {
        state.wasmDisabled = true;
      }
    }
    if (refiner) {
      try {
        const wasm = refiner.run(task.seed, task.deadline);
        const layout = {
          offsets: wasm.offsets,
          faces: wasm.faces,
          axes: wasm.axes,
          chartCount: wasm.chartCount,
        };
        return {
          strategy: task.strategy,
          seed: task.seed,
          cut,
          merge: {
            layout,
            merges: wasm.merges,
            boundaryEdges: wasm.boundaryEdges,
            timedOut: wasm.timedOut,
            unresolved: wasm.unresolved,
            backend: 'wasm',
          },
        };
      } catch {
        state.wasmDisabled = true;
        refiner.dispose();
        state.refiners.delete(task.strategy);
      }
    }
  }

  return runRefineTask(input, spec, cut);
}
