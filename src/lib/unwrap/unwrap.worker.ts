/// <reference lib="webworker" />
import { runUnwrap } from './pipeline';
import type { UnwrapConfig } from './config';
import type { RawMesh } from './types';

type RunRequest = {
  type: 'run';
  raw: RawMesh;
  config: UnwrapConfig;
  version: string;
  inputName: string;
};

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<RunRequest>) => {
  const request = event.data;
  if (request.type !== 'run') return;
  try {
    const result = runUnwrap(request.raw, request.config, {
      version: request.version,
      inputName: request.inputName,
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
