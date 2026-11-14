import type { ConditionedMesh } from './types';

export type ExportGroup = {
  name: string;
  /** First corner index in the export arrays. */
  start: number;
  /** Corner count in this group (a multiple of three). */
  count: number;
};

export type ExportMesh = {
  /** 3 floats per corner. */
  positions: Float32Array;
  /** 3 floats per corner. */
  normals: Float32Array;
  /** 2 floats per corner. */
  uvs: Float32Array;
  /** Sequential corner indices. */
  indices: Uint32Array;
  groups: ExportGroup[];
  cornerCount: number;
  triangleCount: number;
};

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Expands the conditioned mesh into one vertex per triangle corner, using the
 * supplied final UVs. Corner duplication is what makes seams and hard UV
 * borders survive OBJ and GLB export. */
export function buildExportMesh(mesh: ConditionedMesh, triangleUvs: Float32Array): ExportMesh {
  const cornerCount = mesh.triangleCount * 3;
  const positions = new Float32Array(cornerCount * 3);
  const normals = new Float32Array(cornerCount * 3);
  const uvs = new Float32Array(cornerCount * 2);
  const indices = new Uint32Array(cornerCount);
  const groups: ExportGroup[] = [];
  let currentObject = -1;
  let currentGroup: ExportGroup | null = null;

  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    const object = mesh.objectOfTriangle[triangle] ?? 0;
    if (object !== currentObject) {
      currentObject = object;
      currentGroup = {
        name: mesh.objectNames[object] || `Object_${object}`,
        start: triangle * 3,
        count: 0,
      };
      groups.push(currentGroup);
    }
    if (currentGroup) currentGroup.count += 3;

    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = mesh.indices[triangle * 3 + corner];
      const target = triangle * 3 + corner;
      positions[target * 3] = finite(mesh.positions[vertex * 3]);
      positions[target * 3 + 1] = finite(mesh.positions[vertex * 3 + 1]);
      positions[target * 3 + 2] = finite(mesh.positions[vertex * 3 + 2]);
      normals[target * 3] = finite(mesh.normals[vertex * 3]);
      normals[target * 3 + 1] = finite(mesh.normals[vertex * 3 + 1]);
      normals[target * 3 + 2] = finite(mesh.normals[vertex * 3 + 2]);
      uvs[target * 2] = finite(triangleUvs[triangle * 6 + corner * 2]);
      uvs[target * 2 + 1] = finite(triangleUvs[triangle * 6 + corner * 2 + 1]);
      indices[target] = target;
    }
  }

  return {
    positions,
    normals,
    uvs,
    indices,
    groups,
    cornerCount,
    triangleCount: mesh.triangleCount,
  };
}
