/// <reference lib="webworker" />
import { runUnwrap } from './pipeline';
import { createBrowserRefineRunner } from './browserRefinePool';
import type { UnwrapConfig } from './config';
import type { RawMesh } from './types';
import type { RefineRunner } from './smartProject';

type RunRequest = {
  type: 'run';
  raw: RawMesh;
  config: UnwrapConfig;
  version: string;
  inputName: string;
};

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<RunRequest>) => {
  const request = event.data;
  if (request.type !== 'run') return;
  try {
    let refineRunner: RefineRunner | undefined;
    try {
      refineRunner = createBrowserRefineRunner(request.config.refineThreads).runner;
    } catch {
      refineRunner = undefined;
    }
    const result = await runUnwrap(request.raw, request.config, {
      version: request.version,
      inputName: request.inputName,
      refineRunner,
      onProgress: (progress) => scope.postMessage({ type: 'progress', progress }),
    });
    scope.postMessage({ type: 'result', result });
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
