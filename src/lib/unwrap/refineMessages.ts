import type { RefineTaskResult } from './refineTask';
import type { ConditionedMesh, MeshTopology } from './types';
import type { FaceGeometry } from './mesh';
import type { SmartIslandVariant } from './smartProject';

export type RefineWorkerInit = {
  mesh: ConditionedMesh;
  face: FaceGeometry;
  topology: MeshTopology;
  variants: SmartIslandVariant[];
};

export type RefineWorkerRequest =
  | { type: 'init'; input: RefineWorkerInit }
  | { type: 'task'; id: number; strategy: number; seed: number; deadline: number }
  | { type: 'stop' };

export type RefineWorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; result: RefineTaskResult }
  | { type: 'error'; id: number | null; message: string };
