import type { ConditionedMesh, MeshTopology } from './types';

export type MirrorPlane = {
  /** Unit normal pointing from the negative to the positive side. */
  normal: [number, number, number];
  /** Plane equation: dot(position, normal) = offset. */
  offset: number;
  /** Share of sampled vertices with a reflected partner. */
  score: number;
  samples: number;
  matches: number;
  /** Interior edges whose endpoints lie on the plane. */
  seamEdges: number;
  /** Vertices on each side of the plane, sampled. */
  positiveVertices: number;
  negativeVertices: number;
};

export type SymmetryResult = {
  plane: MirrorPlane | null;
  /** 1 for interior edges that lie on the mirror plane. */
  seamEdge: Uint8Array;
  seamCount: number;
  candidates: number;
};

export type SymmetryOptions = {
  /** Reflection match tolerance as a fraction of the bounding-box diagonal. */
  tolerance?: number;
  /** Minimum share of reflected vertices that must find a partner. */
  minScore?: number;
  /** Maximum vertices sampled while scoring a candidate plane. */
  maxSamples?: number;
};

type Candidate = {
  normal: [number, number, number];
  offset: number;
};

const EPSILON = 1e-9;

function normalize(x: number, y: number, z: number): [number, number, number] | null {
  const length = Math.hypot(x, y, z);
  if (!(length > EPSILON)) return null;
  return [x / length, y / length, z / length];
}

/** Jacobi eigen decomposition of a symmetric 3x3 matrix. Returns eigenvectors
 * as columns, independent of eigenvalue order. */
function symmetricEigenvectors(matrix: number[][]): [number, number, number][] {
  const a = matrix.map((row) => row.slice());
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 24; sweep += 1) {
    let largest = 0;
    let p = 0;
    let q = 1;
    for (let row = 0; row < 3; row += 1) {
      for (let column = row + 1; column < 3; column += 1) {
        const value = Math.abs(a[row][column]);
        if (value > largest) {
          largest = value;
          p = row;
          q = column;
        }
      }
    }
    if (largest < 1e-10) break;
    const angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let index = 0; index < 3; index += 1) {
      const ap = a[p][index];
      const aq = a[q][index];
      a[p][index] = cosine * ap - sine * aq;
      a[q][index] = sine * ap + cosine * aq;
    }
    for (let index = 0; index < 3; index += 1) {
      const ap = a[index][p];
      const aq = a[index][q];
      a[index][p] = cosine * ap - sine * aq;
      a[index][q] = sine * ap + cosine * aq;
    }
    for (let index = 0; index < 3; index += 1) {
      const vp = vectors[index][p];
      const vq = vectors[index][q];
      vectors[index][p] = cosine * vp - sine * vq;
      vectors[index][q] = sine * vp + cosine * vq;
    }
  }
  const result: [number, number, number][] = [];
  for (let column = 0; column < 3; column += 1) {
    const axis = normalize(vectors[0][column], vectors[1][column], vectors[2][column]);
    if (axis) result.push(axis);
  }
  return result;
}

function principalAxes(mesh: ConditionedMesh): [number, number, number][] {
  const count = mesh.vertexCount;
  if (count === 0) return [];
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let vertex = 0; vertex < count; vertex += 1) {
    cx += mesh.positions[vertex * 3];
    cy += mesh.positions[vertex * 3 + 1];
    cz += mesh.positions[vertex * 3 + 2];
  }
  cx /= count;
  cy /= count;
  cz /= count;
  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (let vertex = 0; vertex < count; vertex += 1) {
    const x = mesh.positions[vertex * 3] - cx;
    const y = mesh.positions[vertex * 3 + 1] - cy;
    const z = mesh.positions[vertex * 3 + 2] - cz;
    xx += x * x;
    xy += x * y;
    xz += x * z;
    yy += y * y;
    yz += y * z;
    zz += z * z;
  }
  const scale = 1 / Math.max(1, count);
  return symmetricEigenvectors([
    [xx * scale, xy * scale, xz * scale],
    [xy * scale, yy * scale, yz * scale],
    [xz * scale, yz * scale, zz * scale],
  ]);
}

function canonicalKey(normal: [number, number, number], offset: number): string {
  let nx = normal[0];
  let ny = normal[1];
  let nz = normal[2];
  let d = offset;
  if (nx < -1e-9 || (Math.abs(nx) <= 1e-9 && (ny < -1e-9 || (Math.abs(ny) <= 1e-9 && nz < 0)))) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
    d = -d;
  }
  const quantize = (value: number): number => Math.round(value * 1e6) / 1e6;
  return `${quantize(nx)}:${quantize(ny)}:${quantize(nz)}:${quantize(d)}`;
}

function bounds(mesh: ConditionedMesh): {
  min: [number, number, number];
  max: [number, number, number];
  diagonal: number;
  center: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[vertex * 3 + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return {
    min,
    max,
    diagonal,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

function buildVertexHash(
  mesh: ConditionedMesh,
  cellSize: number,
): Map<string, number[]> {
  const hash = new Map<string, number[]>();
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    const ix = Math.floor(mesh.positions[vertex * 3] / cellSize);
    const iy = Math.floor(mesh.positions[vertex * 3 + 1] / cellSize);
    const iz = Math.floor(mesh.positions[vertex * 3 + 2] / cellSize);
    const key = `${ix}:${iy}:${iz}`;
    const bucket = hash.get(key);
    if (bucket) bucket.push(vertex);
    else hash.set(key, [vertex]);
  }
  return hash;
}

function nearestVertex(
  mesh: ConditionedMesh,
  hash: Map<string, number[]>,
  cellSize: number,
  x: number,
  y: number,
  z: number,
  tolerance: number,
): number | null {
  const ix = Math.floor(x / cellSize);
  const iy = Math.floor(y / cellSize);
  const iz = Math.floor(z / cellSize);
  let best = -1;
  let bestDistance = tolerance;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const bucket = hash.get(`${ix + dx}:${iy + dy}:${iz + dz}`);
        if (!bucket) continue;
        for (const vertex of bucket) {
          const px = mesh.positions[vertex * 3] - x;
          const py = mesh.positions[vertex * 3 + 1] - y;
          const pz = mesh.positions[vertex * 3 + 2] - z;
          const distance = Math.hypot(px, py, pz);
          if (distance <= bestDistance) {
            bestDistance = distance;
            best = vertex;
          }
        }
      }
    }
  }
  return best >= 0 ? best : null;
}

function scoreCandidate(
  mesh: ConditionedMesh,
  candidate: Candidate,
  samples: number[],
  hash: Map<string, number[]>,
  cellSize: number,
  tolerance: number,
): MirrorPlane | null {
  const [nx, ny, nz] = candidate.normal;
  let matches = 0;
  let positive = 0;
  let negative = 0;
  for (const vertex of samples) {
    const px = mesh.positions[vertex * 3];
    const py = mesh.positions[vertex * 3 + 1];
    const pz = mesh.positions[vertex * 3 + 2];
    const distance = px * nx + py * ny + pz * nz - candidate.offset;
    if (distance > tolerance) positive += 1;
    else if (distance < -tolerance) negative += 1;
    const reflected = distance * 2;
    if (nearestVertex(
      mesh,
      hash,
      cellSize,
      px - reflected * nx,
      py - reflected * ny,
      pz - reflected * nz,
      tolerance,
    ) !== null) matches += 1;
  }
  const score = samples.length > 0 ? matches / samples.length : 0;
  const minimumSide = Math.max(3, Math.floor(samples.length * 0.05));
  if (positive < minimumSide || negative < minimumSide) return null;
  return {
    normal: [nx, ny, nz],
    offset: candidate.offset,
    score,
    samples: samples.length,
    matches,
    seamEdges: 0,
    positiveVertices: positive,
    negativeVertices: negative,
  };
}

function seamEdgesOnPlane(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  plane: MirrorPlane,
  tolerance: number,
): Uint8Array {
  const seamEdge = new Uint8Array(topology.edges.length);
  const [nx, ny, nz] = plane.normal;
  for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
    const edge = topology.edges[edgeIndex];
    if (edge.boundary || edge.nonManifold) continue;
    const distanceA = Math.abs(
      mesh.positions[edge.a * 3] * nx
      + mesh.positions[edge.a * 3 + 1] * ny
      + mesh.positions[edge.a * 3 + 2] * nz
      - plane.offset,
    );
    if (distanceA > tolerance) continue;
    const distanceB = Math.abs(
      mesh.positions[edge.b * 3] * nx
      + mesh.positions[edge.b * 3 + 1] * ny
      + mesh.positions[edge.b * 3 + 2] * nz
      - plane.offset,
    );
    if (distanceB > tolerance) continue;
    seamEdge[edgeIndex] = 1;
  }
  return seamEdge;
}

/** Finds a dominant bilateral symmetry plane and marks the interior edges that
 * lie on it. World axes and PCA axes through the bounding-box center, origin,
 * and centroid are tested; the best reflection score wins. */
export function detectSymmetry(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  options: SymmetryOptions = {},
): SymmetryResult {
  const empty = new Uint8Array(topology.edges.length);
  if (mesh.vertexCount === 0 || mesh.triangleCount === 0) {
    return { plane: null, seamEdge: empty, seamCount: 0, candidates: 0 };
  }
  const box = bounds(mesh);
  const tolerance = Math.max(1e-7, box.diagonal * (options.tolerance ?? 1e-3));
  const minScore = Math.max(0.5, Math.min(1, options.minScore ?? 0.85));
  const sampleLimit = Math.max(16, options.maxSamples ?? 512);
  const stride = Math.max(1, Math.ceil(mesh.vertexCount / sampleLimit));
  const samples: number[] = [];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += stride) samples.push(vertex);
  const hash = buildVertexHash(mesh, tolerance * 2);

  const normals: [number, number, number][] = [];
  const normalKeys = new Set<string>();
  const addNormal = (normal: [number, number, number] | null): void => {
    if (!normal) return;
    const key = canonicalKey(normal, 0);
    if (normalKeys.has(key)) return;
    normalKeys.add(key);
    normals.push(normal);
  };
  addNormal([1, 0, 0]);
  addNormal([0, 1, 0]);
  addNormal([0, 0, 1]);
  for (const axis of principalAxes(mesh)) addNormal(axis);
  // Symmetry planes often follow a mesh edge direction, especially on hard
  // surface models where the mirror seam was modeled as an edge loop.
  const edgeStride = Math.max(1, Math.ceil(topology.edges.length / 96));
  for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += edgeStride) {
    const edge = topology.edges[edgeIndex];
    addNormal(normalize(
      mesh.positions[edge.b * 3] - mesh.positions[edge.a * 3],
      mesh.positions[edge.b * 3 + 1] - mesh.positions[edge.a * 3 + 1],
      mesh.positions[edge.b * 3 + 2] - mesh.positions[edge.a * 3 + 2],
    ));
    if (normals.length >= 128) break;
  }

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    cx += mesh.positions[vertex * 3];
    cy += mesh.positions[vertex * 3 + 1];
    cz += mesh.positions[vertex * 3 + 2];
  }
  cx /= mesh.vertexCount;
  cy /= mesh.vertexCount;
  cz /= mesh.vertexCount;

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const normal of normals) {
    const offsets: number[] = [];
    offsets.push(box.center[0] * normal[0] + box.center[1] * normal[1] + box.center[2] * normal[2]);
    offsets.push(cx * normal[0] + cy * normal[1] + cz * normal[2]);
    const projected = [
      box.min[0] * normal[0] + box.min[1] * normal[1] + box.min[2] * normal[2],
      box.max[0] * normal[0] + box.max[1] * normal[1] + box.max[2] * normal[2],
    ];
    const low = Math.min(projected[0], projected[1]);
    const high = Math.max(projected[0], projected[1]);
    if (low < 0 && high > 0) offsets.push(0);
    for (const offset of offsets) {
      const key = canonicalKey(normal, offset);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ normal, offset });
    }
  }

  let best: MirrorPlane | null = null;
  let bestSeamEdge: Uint8Array = empty;
  let bestSeamCount = 0;
  for (const candidate of candidates) {
    const scored = scoreCandidate(mesh, candidate, samples, hash, tolerance * 2, tolerance);
    if (!scored || scored.score < minScore) continue;
    if (best && scored.score < best.score - 1e-9) continue;
    const seamEdge = seamEdgesOnPlane(mesh, topology, scored, tolerance);
    let seamCount = 0;
    for (const value of seamEdge) seamCount += value;
    if (!best || scored.score > best.score + 1e-9
      || (Math.abs(scored.score - best.score) <= 1e-9 && seamCount > bestSeamCount)) {
      best = { ...scored, seamEdges: seamCount };
      bestSeamEdge = seamEdge;
      bestSeamCount = seamCount;
    }
  }
  if (!best) {
    return { plane: null, seamEdge: empty, seamCount: 0, candidates: candidates.length };
  }
  return {
    plane: best,
    seamEdge: bestSeamEdge,
    seamCount: bestSeamCount,
    candidates: candidates.length,
  };
}

/** Reflects one point across a mirror plane. */
export function reflectPoint(
  x: number,
  y: number,
  z: number,
  plane: MirrorPlane,
): [number, number, number] {
  const distance = x * plane.normal[0] + y * plane.normal[1] + z * plane.normal[2] - plane.offset;
  return [
    x - 2 * distance * plane.normal[0],
    y - 2 * distance * plane.normal[1],
    z - 2 * distance * plane.normal[2],
  ];
}
