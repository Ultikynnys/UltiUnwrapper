import type { ConditionedMesh, MeshEdge, MeshTopology } from './types';

const MAX_SAFE_VERTEX_COUNT = 90_000_000;

/** Builds undirected edge adjacency once. Edges keep triangle insertion order,
 * so every downstream stage sees the same edge ids for the same mesh. */
export function buildTopology(mesh: ConditionedMesh): MeshTopology {
  if (mesh.vertexCount > MAX_SAFE_VERTEX_COUNT) {
    throw new Error('Mesh has too many vertices for numeric edge keys.');
  }
  const edgeByKey = new Map<number, number>();
  const edges: MeshEdge[] = [];
  const edgeOfTriangle = new Int32Array(mesh.triangleCount * 3).fill(-1);
  const vertexEdges: number[][] = Array.from({ length: mesh.vertexCount }, () => []);
  const keyBase = mesh.vertexCount;

  const addEdge = (a: number, b: number, triangle: number): number => {
    const min = a < b ? a : b;
    const max = a < b ? b : a;
    const key = min * keyBase + max;
    let edge = edgeByKey.get(key);
    if (edge === undefined) {
      edge = edges.length;
      edgeByKey.set(key, edge);
      edges.push({ a: min, b: max, triangles: [triangle], boundary: false, nonManifold: false });
      vertexEdges[min].push(edge);
      vertexEdges[max].push(edge);
    } else {
      edges[edge].triangles.push(triangle);
    }
    return edge;
  };

  for (let tri = 0; tri < mesh.triangleCount; tri += 1) {
    const a = mesh.indices[tri * 3];
    const b = mesh.indices[tri * 3 + 1];
    const c = mesh.indices[tri * 3 + 2];
    if (a === b || b === c || c === a) continue;
    edgeOfTriangle[tri * 3] = addEdge(a, b, tri);
    edgeOfTriangle[tri * 3 + 1] = addEdge(b, c, tri);
    edgeOfTriangle[tri * 3 + 2] = addEdge(c, a, tri);
  }

  const boundaryEdges: number[] = [];
  const nonManifoldEdges: number[] = [];
  for (let edge = 0; edge < edges.length; edge += 1) {
    const record = edges[edge];
    record.boundary = record.triangles.length === 1;
    record.nonManifold = record.triangles.length > 2;
    if (record.boundary) boundaryEdges.push(edge);
    if (record.nonManifold) nonManifoldEdges.push(edge);
  }

  return { edges, edgeOfTriangle, boundaryEdges, nonManifoldEdges, vertexEdges };
}

export function topologyStats(topology: MeshTopology): {
  edges: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
} {
  return {
    edges: topology.edges.length,
    boundaryEdges: topology.boundaryEdges.length,
    nonManifoldEdges: topology.nonManifoldEdges.length,
  };
}

/** Edge length in world units. */
export function edgeLength(mesh: ConditionedMesh, edge: MeshEdge): number {
  const dx = mesh.positions[edge.b * 3] - mesh.positions[edge.a * 3];
  const dy = mesh.positions[edge.b * 3 + 1] - mesh.positions[edge.a * 3 + 1];
  const dz = mesh.positions[edge.b * 3 + 2] - mesh.positions[edge.a * 3 + 2];
  return Math.hypot(dx, dy, dz);
}
