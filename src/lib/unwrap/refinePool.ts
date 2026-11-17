import { nowEpoch } from './clock';
import {
  chartLayoutBBoxArea,
  type RefineRunnerInput,
  type SmartRefineOutcome,
} from './smartProject';
import {
  strategyTarget,
  totalStrategies,
  type RefineTaskResult,
} from './refineTask';
import type {
  RefineWorkerInit,
  RefineWorkerRequest,
  RefineWorkerResponse,
} from './refineMessages';

export const MAX_REFINE_THREADS = 8;
export const AUTO_REFINE_THREAD_CAP = 4;
/** Below this face count the worker startup cost outweighs the search gain. */
export const SMALL_REFINE_MESH_FACES = 128;
/** Consecutive completed tasks without a better layout before the pool stops
 * early once every strategy has produced a result. */
export const REFINE_STAGNATION_TASKS = 4096;

export type RefineWorkerHandle = {
  postMessage(message: RefineWorkerRequest): void;
  onMessage(listener: (message: RefineWorkerResponse) => void): void;
  onError(listener: (error: Error) => void): void;
  terminate(): void;
};

export type RefineWorkerFactory = () => Promise<RefineWorkerHandle>;

export type RefinePoolOptions = {
  threads: number;
  createWorker: RefineWorkerFactory;
};

export function resolveRefineThreads(requested: number, available: number): number {
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(MAX_REFINE_THREADS, Math.max(1, Math.floor(requested)));
  }
  const cpus = Number.isFinite(available) && available > 0 ? Math.floor(available) : 1;
  return Math.max(1, Math.min(AUTO_REFINE_THREAD_CAP, cpus - 1));
}

function workerInit(input: RefineRunnerInput): RefineWorkerInit {
  return {
    mesh: input.mesh,
    face: input.face,
    topology: input.topology,
    variants: input.variants,
  };
}

function initialize(
  worker: RefineWorkerHandle,
  input: RefineWorkerInit,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('The refinement worker did not start in time.'));
    }, 10_000);
    const settle = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    worker.onMessage((message) => {
      if (message.type === 'ready') settle();
      else if (message.type === 'error') settle(new Error(message.message));
    });
    worker.onError((error) => settle(error));
    const request: RefineWorkerRequest = { type: 'init', input };
    worker.postMessage(request);
  });
}

async function startWorkers(
  input: RefineWorkerInit,
  count: number,
  createWorker: RefineWorkerFactory,
): Promise<RefineWorkerHandle[]> {
  const workers: RefineWorkerHandle[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      workers.push(await createWorker());
    }
    await Promise.all(workers.map((worker) => initialize(worker, input)));
    return workers;
  } catch (error) {
    for (const worker of workers) worker.terminate();
    throw error;
  }
}

/** Runs independent variant, cut, and merge tasks on a worker pool and keeps
 * the best valid layout. The caller chooses sequential execution when
 * threading is not worthwhile. */
export async function runRefinePool(
  input: RefineRunnerInput,
  options: RefinePoolOptions,
): Promise<SmartRefineOutcome> {
  const started = performance.now();
  const threads = Math.max(1, Math.min(MAX_REFINE_THREADS, Math.floor(options.threads)));
  const strategyCount = totalStrategies(input.variants);
  if (strategyCount === 0) throw new Error('No refinement strategies were provided.');
  const variantOfStrategy = new Array<number>(strategyCount);
  for (let strategy = 0; strategy < strategyCount; strategy += 1) {
    const target = strategyTarget(input.variants, strategy);
    if (!target) throw new Error(`Strategy ${strategy} has no variant.`);
    variantOfStrategy[strategy] = target.variantIndex;
  }
  const workerCount = Math.min(threads, strategyCount);
  const workers = await startWorkers(workerInit(input), workerCount, options.createWorker);
  const deadline = input.deadline;

  return new Promise((resolve, reject) => {
    const queues = workers.map(() => [] as Array<{ id: number; strategy: number; seed: number }>);
    const nextSeed = new Array<number>(strategyCount).fill(1);
    const attempted = new Set<number>();
    const dead = new Set<number>();
    const busy = workers.map(() => false);
    let nextTaskId = 0;
    let completed = 0;
    let wasmTasks = 0;
    let settled = false;
    let best: RefineTaskResult | null = null;
    let bestBBox = Infinity;
    let lastImprovement = 0;
    let stoppedEarly = false;
    const completedStrategies = new Set<number>();
    const stagnationLimit = Math.max(REFINE_STAGNATION_TASKS, strategyCount * 128);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      for (const worker of workers) worker.terminate();
      if (!best) {
        reject(new Error('No refinement task completed.'));
        return;
      }
      const chosen = best;
      const variant = input.variants[variantOfStrategy[chosen.strategy]];
      resolve({
        layout: chosen.merge.layout,
        islandMerges: chosen.merge.merges,
        refineRestarts: completed,
        wasmTasks,
        cutAttempts: attempted.size,
        islandBoundaryEdges: chosen.merge.boundaryEdges,
        densityRounds: chosen.cut.rounds,
        densitySplits: chosen.cut.splits,
        densitySpreadBefore: chosen.cut.spreadBefore,
        densityUnresolved: chosen.merge.unresolved,
        refineTimedOut: nowEpoch() >= deadline || chosen.merge.timedOut || chosen.cut.timedOut,
        refineStoppedEarly: stoppedEarly,
        refineTimeMs: performance.now() - started,
        budgetMs: input.budgetMs,
        strategyVariants: input.variants.length,
        strategyAttempts: attempted.size,
        bestStrategy: chosen.strategy,
        variantId: variant?.id ?? '',
      });
    };

    const fail = (error: Error): void => {
      if (settled) return;
      if (best) finish();
      else {
        settled = true;
        if (timer !== null) clearTimeout(timer);
        for (const worker of workers) worker.terminate();
        reject(error);
      }
    };

    const schedule = (strategy: number): void => {
      if (dead.has(strategy)) return;
      queues[strategy % workers.length].push({
        id: nextTaskId++,
        strategy,
        seed: nextSeed[strategy]++,
      });
    };

    const dispatch = (): void => {
      if (settled) return;
      if (nowEpoch() >= deadline) {
        finish();
        return;
      }
      for (let index = 0; index < workers.length; index += 1) {
        if (busy[index]) continue;
        const task = queues[index].shift();
        if (!task) continue;
        busy[index] = true;
        attempted.add(task.strategy);
        const request: RefineWorkerRequest = {
          type: 'task',
          id: task.id,
          strategy: task.strategy,
          seed: task.seed,
          deadline,
        };
        workers[index].postMessage(request);
      }
      if (queues.every((queue) => queue.length === 0) && busy.every((value) => !value)) finish();
    };

    const maybeStop = (): void => {
      if (settled) return;
      if (completedStrategies.size < strategyCount) return;
      if (completed - lastImprovement < stagnationLimit) return;
      stoppedEarly = true;
      finish();
    };

    const handleResult = (result: RefineTaskResult): void => {
      completed += 1;
      completedStrategies.add(result.strategy);
      if (result.merge.backend === 'wasm') wasmTasks += 1;
      if (!best) {
        best = result;
        bestBBox = chartLayoutBBoxArea(input.mesh, result.merge.layout);
        lastImprovement = completed;
      } else {
        let accept = false;
        let candidateBBox = Infinity;
        if (result.merge.unresolved !== best.merge.unresolved) {
          accept = result.merge.unresolved < best.merge.unresolved;
        } else if (result.merge.layout.chartCount !== best.merge.layout.chartCount) {
          accept = result.merge.layout.chartCount < best.merge.layout.chartCount;
        } else {
          candidateBBox = chartLayoutBBoxArea(input.mesh, result.merge.layout);
          if (candidateBBox < bestBBox - 1e-9) accept = true;
          else if (Math.abs(candidateBBox - bestBBox) <= 1e-9) {
            accept = result.merge.boundaryEdges > best.merge.boundaryEdges;
          }
        }
        if (accept) {
          best = result;
          bestBBox = Number.isFinite(candidateBBox)
            ? candidateBBox
            : chartLayoutBBoxArea(input.mesh, result.merge.layout);
          lastImprovement = completed;
        }
      }
      if (result.cut.unresolved > 0 || result.cut.timedOut) {
        dead.add(result.strategy);
        maybeStop();
        return;
      }
      if (result.merge.timedOut || result.merge.layout.chartCount <= 1) {
        maybeStop();
        return;
      }
      if (result.merge.merges === 0) {
        maybeStop();
        return;
      }
      schedule(result.strategy);
      maybeStop();
    };

    for (let index = 0; index < workers.length; index += 1) {
      const worker = workers[index];
      worker.onMessage((message) => {
        if (settled) return;
        if (message.type === 'error') {
          fail(new Error(message.message));
          return;
        }
        if (message.type !== 'result') return;
        busy[index] = false;
        handleResult(message.result);
        dispatch();
      });
      worker.onError(fail);
    }

    const remaining = Math.max(0, deadline - nowEpoch());
    timer = setTimeout(finish, remaining + 500);

    for (let strategy = 0; strategy < strategyCount; strategy += 1) {
      queues[strategy % workers.length].push({ id: nextTaskId++, strategy, seed: 0 });
    }
    dispatch();
  });
}
