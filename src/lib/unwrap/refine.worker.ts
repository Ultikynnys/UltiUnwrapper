/// <reference lib="webworker" />
import {
  createRefineWorkerState,
  disposeRefineWorkerState,
  executeRefineWorkerTask,
  setRefineWorkerInput,
  type RefineWorkerState,
} from './refineWorkerTask';
import type { RefineWorkerRequest, RefineWorkerResponse } from './refineMessages';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let state: RefineWorkerState = createRefineWorkerState();

function reply(message: RefineWorkerResponse): void {
  scope.postMessage(message);
}

scope.onmessage = async (event: MessageEvent<RefineWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'init') {
    disposeRefineWorkerState(state);
    state = createRefineWorkerState();
    setRefineWorkerInput(state, request.input);
    reply({ type: 'ready' });
    return;
  }
  if (request.type === 'stop') {
    disposeRefineWorkerState(state);
    scope.close();
    return;
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
};
