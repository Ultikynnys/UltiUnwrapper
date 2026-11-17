import {
  resolveRefineThreads,
  runRefinePool,
  SMALL_REFINE_MESH_FACES,
  type RefineWorkerHandle,
} from './refinePool';
import {
  refineSmartIslandsSequential,
  type RefineRunner,
} from './smartProject';
import type { RefineWorkerResponse } from './refineMessages';

async function createBrowserWorker(): Promise<RefineWorkerHandle> {
  if (typeof Worker === 'undefined') {
    throw new Error('This environment does not support Web Workers.');
  }
  const worker = new Worker(new URL('./refine.worker.ts', import.meta.url), { type: 'module' });
  return {
    postMessage(message) {
      worker.postMessage(message);
    },
    onMessage(listener) {
      worker.addEventListener('message', (event: MessageEvent<RefineWorkerResponse>) => {
        listener(event.data);
      });
    },
    onError(listener) {
      worker.addEventListener('error', (event: ErrorEvent) => {
        listener(new Error(event.message || 'Refinement worker failed.'));
      });
    },
    terminate() {
      worker.terminate();
    },
  };
}

export function createBrowserRefineRunner(requested: number): {
  runner: RefineRunner;
  dispose: () => void;
  threads: number;
} {
  const available = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4;
  const threads = resolveRefineThreads(requested, available);
  return {
    threads,
    runner: async (input) => {
      if (threads <= 1 || input.face.areas.length < SMALL_REFINE_MESH_FACES) {
        return refineSmartIslandsSequential(input);
      }
      return runRefinePool(input, { threads, createWorker: createBrowserWorker });
    },
    dispose: () => {},
  };
}
