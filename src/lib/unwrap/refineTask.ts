import {
  compactChartLayout,
  layoutDensityUnresolved,
  minimizeChartLayout,
  refineChartsByDensity,
} from './smartProject';
import type { ChartLayout, ChartUv, ConditionedMesh, MeshTopology } from './types';
import type { FaceGeometry } from './mesh';
import type { MirrorPlane } from './symmetry';

export type StrategyVariant = { cutStrategies: number };
export type StrategyTarget = { variantIndex: number; cutStrategy: number };

export function totalStrategies(variants: ReadonlyArray<StrategyVariant>): number {
  let total = 0;
  for (const variant of variants) total += Math.max(0, Math.floor(variant.cutStrategies));
  return total;
}

export function strategyTarget(
  variants: ReadonlyArray<StrategyVariant>,
  strategy: number,
): StrategyTarget | null {
  if (!Number.isInteger(strategy) || strategy < 0) return null;
  let offset = 0;
  for (let index = 0; index < variants.length; index += 1) {
    const count = Math.max(0, Math.floor(variants[index].cutStrategies));
    if (strategy < offset + count) {
      return { variantIndex: index, cutStrategy: strategy - offset };
    }
    offset += count;
  }
  return null;
}

/** Everything a refinement attempt needs. Plain typed arrays and chart
 * objects keep this structured-clone safe for worker threads. */
export type RefineTaskInput = {
  mesh: ConditionedMesh;
  face: FaceGeometry;
  topology: MeshTopology;
  seamEdge: Uint8Array;
  neighbors: number[][];
  baseCharts: ChartUv[];
  tolerance: number;
  mergeCos: number;
  axisMergeCos: number;
  mirrorPlane?: MirrorPlane | null;
};

export type CutLayout = {
  charts: ChartUv[];
  rounds: number;
  splits: number;
  unresolved: number;
  spreadBefore: number;
  spreadAfter: number;
  timedOut: boolean;
};

export type MergeTaskResult = {
  layout: ChartLayout;
  merges: number;
  boundaryEdges: number;
  timedOut: boolean;
  unresolved: number;
  backend?: 'wasm' | 'js';
};

export type RefineTaskSpec = {
  strategy: number;
  seed: number;
  /** Absolute epoch milliseconds, shared by every thread. */
  deadline: number;
};

export type RefineTaskResult = {
  strategy: number;
  seed: number;
  cut: CutLayout;
  merge: MergeTaskResult;
};


export function prepareCutLayout(
  input: RefineTaskInput,
  strategy: number,
  deadline: number,
): CutLayout {
  const refined = refineChartsByDensity(
    input.baseCharts,
    input.mesh,
    input.face,
    input.neighbors,
    input.tolerance,
    strategy,
    deadline,
    input.mirrorPlane,
  );
  return {
    charts: refined.charts,
    rounds: refined.rounds,
    splits: refined.splits,
    unresolved: refined.unresolved,
    spreadBefore: refined.spreadBefore,
    spreadAfter: refined.spreadAfter,
    timedOut: refined.timedOut,
  };
}

export function runMergeTask(
  input: RefineTaskInput,
  charts: ChartUv[],
  seed: number,
  deadline: number,
): MergeTaskResult {
  const minimized = minimizeChartLayout(
    charts,
    input.mesh,
    input.face,
    input.topology,
    input.seamEdge,
    input.tolerance,
    deadline,
    input.mergeCos,
    input.axisMergeCos,
    seed,
  );
  return {
    layout: minimized.layout,
    merges: minimized.merges,
    boundaryEdges: minimized.boundaryEdges,
    timedOut: minimized.timedOut,
    unresolved: layoutDensityUnresolved(
      input.mesh,
      input.face,
      minimized.layout,
      input.tolerance,
    ),
    backend: 'js',
  };
}

/** One cut strategy followed by one merge pass. This is the unit of work the
 * thread pool distributes. A caller that already prepared the cut layout can
 * pass it in to avoid rebuilding it for every seed. */
export function runRefineTask(
  input: RefineTaskInput,
  spec: RefineTaskSpec,
  prepared?: CutLayout,
): RefineTaskResult {
  const cut = prepared ?? prepareCutLayout(input, spec.strategy, spec.deadline);
  if (cut.timedOut || cut.unresolved > 0) {
    return {
      strategy: spec.strategy,
      seed: spec.seed,
      cut,
      merge: {
        layout: compactChartLayout(cut.charts, input.face),
        merges: 0,
        boundaryEdges: 0,
        timedOut: cut.timedOut,
        unresolved: cut.unresolved,
        backend: 'js',
      },
    };
  }
  return {
    strategy: spec.strategy,
    seed: spec.seed,
    cut,
    merge: runMergeTask(input, cut.charts, spec.seed, spec.deadline),
  };
}
