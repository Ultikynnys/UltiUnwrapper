import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import {
  resolveRefineThreads,
  runRefinePool,
  SMALL_REFINE_MESH_FACES,
  type RefineWorkerHandle,
} from '../src/lib/unwrap/refinePool';
import {
  refineSmartIslandsSequential,
  type RefineRunner,
} from '../src/lib/unwrap/smartProject';

export { resolveRefineThreads };

async function createNodeWorker(): Promise<RefineWorkerHandle> {
  const worker = new Worker(new URL('./refine.worker.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
  });
  return {
    postMessage(message) {
      worker.postMessage(message);
    },
    onMessage(listener) {
      worker.on('message', listener);
    },
    onError(listener) {
      worker.on('error', (error) => listener(error instanceof Error ? error : new Error(String(error))));
    },
    terminate() {
      void worker.terminate();
    },
  };
}

export function createNodeRefineRunner(requested: number): {
  runner: RefineRunner;
  dispose: () => void;
  threads: number;
} {
  const threads = resolveRefineThreads(requested, availableParallelism());
  return {
    threads,
    runner: async (input) => {
      if (threads <= 1 || input.face.areas.length < SMALL_REFINE_MESH_FACES) {
        return refineSmartIslandsSequential(input);
      }
      return runRefinePool(input, { threads, createWorker: createNodeWorker });
    },
    dispose: () => {},
  };
}
