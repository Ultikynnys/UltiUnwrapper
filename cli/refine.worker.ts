import { parentPort } from 'node:worker_threads';
import {
  createRefineWorkerState,
  disposeRefineWorkerState,
  executeRefineWorkerTask,
  setRefineWorkerInput,
  type RefineWorkerState,
} from '../src/lib/unwrap/refineWorkerTask';
import type { RefineWorkerRequest, RefineWorkerResponse } from '../src/lib/unwrap/refineMessages';

const port = parentPort;
if (!port) throw new Error('The refinement worker needs a parent port.');

let state: RefineWorkerState = createRefineWorkerState();

function reply(message: RefineWorkerResponse): void {
  port!.postMessage(message);
}

port.on('message', async (request: RefineWorkerRequest) => {
  if (request.type === 'init') {
    disposeRefineWorkerState(state);
    state = createRefineWorkerState();
    setRefineWorkerInput(state, request.input);
    reply({ type: 'ready' });
    return;
  }
  if (request.type === 'stop') {
    disposeRefineWorkerState(state);
    process.exit(0);
  }
  try {
    const result = await executeRefineWorkerTask(state, {
      id: request.id,
      strategy: request.strategy,
      seed: request.seed,
      deadline: request.deadline,
    });
    reply({ type: 'result', id: request.id, result });
  } catch (error) {
    reply({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
