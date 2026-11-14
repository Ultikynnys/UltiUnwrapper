import type { FaceGeometry } from './mesh';
import type { ConditionedMesh, Issue, MeshTopology } from './types';

export type SeamOptions = {
  /** Dihedral angle in degrees at or above which an edge becomes a seam. */
  seamAngle: number;
  /** Keep source objects as separate charts. */
  splitByObject: boolean;
  /** Keep source material groups as separate charts. */
  splitByMaterial: boolean;
  /** Use UV discontinuities from the input as seams. Default true. */
  useUvSeams?: boolean;
};

export type SeamResult = {
  /** 1 for every chart border edge, including model boundaries. */
  seamEdge: Uint8Array;
  interiorSeamCount: number;
  interiorSeamLength: number;
  boundaryCount: number;
  nonManifoldCount: number;
  objectSeamCount: number;
  materialSeamCount: number;
  dihedralSeamCount: number;
  uvSeamCount?: number;
  issues: Issue[];
};

function edgeLength(mesh: ConditionedMesh, a: number, b: number): number {
  return Math.hypot(
    mesh.positions[b * 3] - mesh.positions[a * 3],
    mesh.positions[b * 3 + 1] - mesh.positions[a * 3 + 1],
    mesh.positions[b * 3 + 2] - mesh.positions[a * 3 + 2],
  );
}

/** Chooses chart borders from dihedral angle, object/material boundaries, and
 * non-manifold edges. Model boundaries are marked too, because every consumer
 * treats them as chart borders even though they are not artists' seams. */
export function computeSeams(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  face: FaceGeometry,
  options: SeamOptions,
): SeamResult {
  const seamEdge = new Uint8Array(topology.edges.length);
  let interiorSeamCount = 0;
  let interiorSeamLength = 0;
  let boundaryCount = 0;
  let nonManifoldCount = 0;
  let objectSeamCount = 0;
  let materialSeamCount = 0;
  let dihedralSeamCount = 0;
  let uvSeamCount = 0;
  const threshold = Math.max(0, Math.min(180, options.seamAngle));
  const cosThreshold = Math.cos((threshold * Math.PI) / 180);

  for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
    const edge = topology.edges[edgeIndex];
    if (edge.boundary) {
      seamEdge[edgeIndex] = 1;
      boundaryCount += 1;
      continue;
    }
    if (edge.nonManifold) {
      seamEdge[edgeIndex] = 1;
      nonManifoldCount += 1;
      continue;
    }
    const t0 = edge.triangles[0];
    const t1 = edge.triangles[1];
    let seam = false;
    if (options.splitByObject && mesh.objectOfTriangle[t0] !== mesh.objectOfTriangle[t1]) {
      seam = true;
      objectSeamCount += 1;
    } else if (
      options.splitByMaterial
      && mesh.materialOfTriangle[t0] !== mesh.materialOfTriangle[t1]
      && mesh.materialOfTriangle[t0] >= 0
      && mesh.materialOfTriangle[t1] >= 0
    ) {
      seam = true;
      materialSeamCount += 1;
    } else {
      const nx = face.normals[t0 * 3];
      const ny = face.normals[t0 * 3 + 1];
      const nz = face.normals[t0 * 3 + 2];
      const dot = nx * face.normals[t1 * 3]
        + ny * face.normals[t1 * 3 + 1]
        + nz * face.normals[t1 * 3 + 2];
      if (dot <= cosThreshold) {
        seam = true;
        dihedralSeamCount += 1;
      }
    }
    if (seam) {
      seamEdge[edgeIndex] = 1;
      interiorSeamCount += 1;
      interiorSeamLength += edgeLength(mesh, edge.a, edge.b);
    }
  }

  const uvs = mesh.triangleUvs;
  if (uvs && options.useUvSeams !== false) {
    const uvOf = (triangle: number, vertex: number): [number, number] | null => {
      for (let corner = 0; corner < 3; corner += 1) {
        if (mesh.indices[triangle * 3 + corner] !== vertex) continue;
        const offset = (triangle * 3 + corner) * 2;
        return [uvs[offset], uvs[offset + 1]];
      }
      return null;
    };
    for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
      const edge = topology.edges[edgeIndex];
      if (seamEdge[edgeIndex] || edge.triangles.length !== 2) continue;
      const [t0, t1] = edge.triangles;
      const a0 = uvOf(t0, edge.a);
      const b0 = uvOf(t0, edge.b);
      const a1 = uvOf(t1, edge.a);
      const b1 = uvOf(t1, edge.b);
      if (!a0 || !b0 || !a1 || !b1) continue;
      const delta = Math.max(
        Math.hypot(a0[0] - a1[0], a0[1] - a1[1]),
        Math.hypot(b0[0] - b1[0], b0[1] - b1[1]),
      );
      if (delta <= 1e-5) continue;
      seamEdge[edgeIndex] = 1;
      uvSeamCount += 1;
      interiorSeamCount += 1;
      interiorSeamLength += edgeLength(mesh, edge.a, edge.b);
    }
  }

  const issues: Issue[] = [];
  if (nonManifoldCount > 0) {
    issues.push({
      stage: 'segment',
      severity: 'warn',
      code: 'non-manifold-seams',
      message: `${nonManifoldCount} non-manifold edge${nonManifoldCount === 1 ? '' : 's'} treated as seams.`,
      value: nonManifoldCount,
    });
  }

  return {
    seamEdge,
    interiorSeamCount,
    interiorSeamLength,
    boundaryCount,
    nonManifoldCount,
    objectSeamCount,
    materialSeamCount,
    dihedralSeamCount,
    uvSeamCount,
    issues,
  };
}
