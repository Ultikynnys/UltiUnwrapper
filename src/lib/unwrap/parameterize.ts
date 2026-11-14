import { solveLscm, type LscmTriangle } from './lscm';
import { computeFaceMetrics, signedTriangleArea2D, summarize } from './metrics';
import { solveConjugateGradient } from './solver';
import { mirrorU } from './uvMath';
import type { FaceGeometry } from './mesh';
import type {
  Chart,
  ChartFailure,
  ChartUv,
  ConditionedMesh,
  Issue,
  MeshTopology,
  ParameterizeOptions,
  ParameterizeResult,
  Segmentation,
  StageStats,
  Vec3,
} from './types';

const EPSILON = 1e-12;

type ProjectedChart = {
  positions: Float32Array;
  projected: Float32Array;
  normal: Vec3;
  diagonal: number;
  planar: boolean;
  signedArea: number;
};

function normalize(x: number, y: number, z: number): Vec3 | null {
  const length = Math.hypot(x, y, z);
  if (length <= EPSILON) return null;
  return [x / length, y / length, z / length];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function areaNormal(chart: Chart, face: FaceGeometry): { normal: Vec3 | null; coherence: number } {
  let x = 0;
  let y = 0;
  let z = 0;
  let total = 0;
  for (const triangle of chart.triangles) {
    const weight = face.areas[triangle];
    x += face.normals[triangle * 3] * weight;
    y += face.normals[triangle * 3 + 1] * weight;
    z += face.normals[triangle * 3 + 2] * weight;
    total += weight;
  }
  const length = Math.hypot(x, y, z);
  if (length <= EPSILON || total <= EPSILON) return { normal: null, coherence: 0 };
  return {
    normal: [x / length, y / length, z / length],
    coherence: length / total,
  };
}

/** Least-squares plane normal from the chart's vertex positions. Used when the
 * area-weighted normals cancel around a tube or sphere, where a mean normal
 * would collapse the projection. */
function pcaNormal(positions: Float32Array): Vec3 {
  const count = positions.length / 3;
  if (count === 0) return [0, 1, 0];
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let vertex = 0; vertex < count; vertex += 1) {
    cx += positions[vertex * 3];
    cy += positions[vertex * 3 + 1];
    cz += positions[vertex * 3 + 2];
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
    const dx = positions[vertex * 3] - cx;
    const dy = positions[vertex * 3 + 1] - cy;
    const dz = positions[vertex * 3 + 2] - cz;
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }
  const matrix = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
  const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iteration = 0; iteration < 16; iteration += 1) {
    let p = 0;
    let q = 1;
    let largest = Math.abs(matrix[0][1]);
    if (Math.abs(matrix[0][2]) > largest) {
      p = 0;
      q = 2;
      largest = Math.abs(matrix[0][2]);
    }
    if (Math.abs(matrix[1][2]) > largest) {
      p = 1;
      q = 2;
      largest = Math.abs(matrix[1][2]);
    }
    if (largest <= 1e-14) break;
    const theta = 0.5 * Math.atan2(2 * matrix[p][q], matrix[q][q] - matrix[p][p]);
    const cosine = Math.cos(theta);
    const sine = Math.sin(theta);
    for (let i = 0; i < 3; i += 1) {
      const aip = matrix[i][p];
      const aiq = matrix[i][q];
      matrix[i][p] = cosine * aip - sine * aiq;
      matrix[i][q] = sine * aip + cosine * aiq;
    }
    for (let i = 0; i < 3; i += 1) {
      const api = matrix[p][i];
      const aqi = matrix[q][i];
      matrix[p][i] = cosine * api - sine * aqi;
      matrix[q][i] = sine * api + cosine * aqi;
    }
    for (let i = 0; i < 3; i += 1) {
      const vip = vectors[i][p];
      const viq = vectors[i][q];
      vectors[i][p] = cosine * vip - sine * viq;
      vectors[i][q] = sine * vip + cosine * viq;
    }
  }
  let smallest = 0;
  if (matrix[1][1] < matrix[smallest][smallest]) smallest = 1;
  if (matrix[2][2] < matrix[smallest][smallest]) smallest = 2;
  return normalize(vectors[0][smallest], vectors[1][smallest], vectors[2][smallest]) ?? [0, 1, 0];
}

function localPositions(mesh: ConditionedMesh, chart: Chart): Float32Array {
  const positions = new Float32Array(chart.localVertex.length * 3);
  for (let local = 0; local < chart.localVertex.length; local += 1) {
    const global = chart.localVertex[local];
    positions[local * 3] = mesh.positions[global * 3];
    positions[local * 3 + 1] = mesh.positions[global * 3 + 1];
    positions[local * 3 + 2] = mesh.positions[global * 3 + 2];
  }
  return positions;
}

function tangentFromChart(mesh: ConditionedMesh, chart: Chart, normal: Vec3): Vec3 {
  let bestTriangle = -1;
  let bestArea = -1;
  for (const triangle of chart.triangles) {
    const ia = mesh.indices[triangle * 3];
    const ib = mesh.indices[triangle * 3 + 1];
    const ic = mesh.indices[triangle * 3 + 2];
    const ux = mesh.positions[ib * 3] - mesh.positions[ia * 3];
    const uy = mesh.positions[ib * 3 + 1] - mesh.positions[ia * 3 + 1];
    const uz = mesh.positions[ib * 3 + 2] - mesh.positions[ia * 3 + 2];
    const vx = mesh.positions[ic * 3] - mesh.positions[ia * 3];
    const vy = mesh.positions[ic * 3 + 1] - mesh.positions[ia * 3 + 1];
    const vz = mesh.positions[ic * 3 + 2] - mesh.positions[ia * 3 + 2];
    const area = 0.5 * Math.hypot(
      uy * vz - uz * vy,
      uz * vx - ux * vz,
      ux * vy - uy * vx,
    );
    if (area > bestArea) {
      bestArea = area;
      bestTriangle = triangle;
    }
  }
  if (bestTriangle >= 0) {
    const ia = mesh.indices[bestTriangle * 3];
    const ib = mesh.indices[bestTriangle * 3 + 1];
    const edge: Vec3 = [
      mesh.positions[ib * 3] - mesh.positions[ia * 3],
      mesh.positions[ib * 3 + 1] - mesh.positions[ia * 3 + 1],
      mesh.positions[ib * 3 + 2] - mesh.positions[ia * 3 + 2],
    ];
    const projected = normalize(
      edge[0] - normal[0] * dot(edge, normal),
      edge[1] - normal[1] * dot(edge, normal),
      edge[2] - normal[2] * dot(edge, normal),
    );
    if (projected) return projected;
  }
  const axis: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(
    axis[1] * normal[2] - axis[2] * normal[1],
    axis[2] * normal[0] - axis[0] * normal[2],
    axis[0] * normal[1] - axis[1] * normal[0],
  ) ?? [1, 0, 0];
}

function project(
  positions: Float32Array,
  tangent: Vec3,
  bitangent: Vec3,
): Float32Array {
  const projected = new Float32Array((positions.length / 3) * 2);
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    projected[vertex * 2] = x * tangent[0] + y * tangent[1] + z * tangent[2];
    projected[vertex * 2 + 1] = x * bitangent[0] + y * bitangent[1] + z * bitangent[2];
  }
  return projected;
}

function chartSignedArea(projected: Float32Array, localIndices: Uint32Array): number {
  let area = 0;
  for (let triangle = 0; triangle < localIndices.length / 3; triangle += 1) {
    const a = localIndices[triangle * 3] * 2;
    const b = localIndices[triangle * 3 + 1] * 2;
    const c = localIndices[triangle * 3 + 2] * 2;
    area += signedTriangleArea2D(
      projected[a], projected[a + 1],
      projected[b], projected[b + 1],
      projected[c], projected[c + 1],
    );
  }
  return area;
}

function projectChart(
  mesh: ConditionedMesh,
  chart: Chart,
  face: FaceGeometry,
): ProjectedChart | null {
  const positions = localPositions(mesh, chart);
  const area = areaNormal(chart, face);
  const normal = area.normal && area.coherence > 0.5 ? area.normal : pcaNormal(positions);
  const tangent = tangentFromChart(mesh, chart, normal);
  let bitangent = normalize(
    normal[1] * tangent[2] - normal[2] * tangent[1],
    normal[2] * tangent[0] - normal[0] * tangent[2],
    normal[0] * tangent[1] - normal[1] * tangent[0],
  );
  if (!bitangent) return null;
  let projected = project(positions, tangent, bitangent);
  let signedArea = chartSignedArea(projected, chart.localIndices);
  if (signedArea < 0) {
    bitangent = [-bitangent[0], -bitangent[1], -bitangent[2]];
    projected = project(positions, tangent, bitangent);
    signedArea = -signedArea;
  }
  if (!(Math.abs(signedArea) > EPSILON)) signedArea = 0;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const vertexCount = positions.length / 3;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    cx += x;
    cy += y;
    cz += z;
    const u = projected[vertex * 2];
    const v = projected[vertex * 2 + 1];
    if (u < minX) minX = u;
    if (v < minY) minY = v;
    if (u > maxX) maxX = u;
    if (v > maxY) maxY = v;
  }
  cx /= vertexCount;
  cy /= vertexCount;
  cz /= vertexCount;
  let maxDistance = 0;
  let min3X = Infinity;
  let min3Y = Infinity;
  let min3Z = Infinity;
  let max3X = -Infinity;
  let max3Y = -Infinity;
  let max3Z = -Infinity;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    const distance = Math.abs((x - cx) * normal[0] + (y - cy) * normal[1] + (z - cz) * normal[2]);
    if (distance > maxDistance) maxDistance = distance;
    min3X = Math.min(min3X, x);
    min3Y = Math.min(min3Y, y);
    min3Z = Math.min(min3Z, z);
    max3X = Math.max(max3X, x);
    max3Y = Math.max(max3Y, y);
    max3Z = Math.max(max3Z, z);
  }
  const diagonal = Math.hypot(max3X - min3X, max3Y - min3Y, max3Z - min3Z);
  return {
    positions,
    projected,
    normal,
    diagonal,
    planar: Math.abs(signedArea) > EPSILON && maxDistance <= Math.max(1e-7, diagonal * 1e-6),
    signedArea,
  };
}

function choosePins(projected: Float32Array, vertexCount: number): [number, number] | null {
  if (vertexCount < 2) return null;
  let candidates: number[];
  if (vertexCount <= 256) {
    candidates = Array.from({ length: vertexCount }, (_, index) => index);
  } else {
    let minX = 0;
    let maxX = 0;
    let minY = 0;
    let maxY = 0;
    let minSum = 0;
    let maxSum = 0;
    let minDiff = 0;
    let maxDiff = 0;
    for (let vertex = 1; vertex < vertexCount; vertex += 1) {
      const u = projected[vertex * 2];
      const v = projected[vertex * 2 + 1];
      if (u < projected[minX * 2]) minX = vertex;
      if (u > projected[maxX * 2]) maxX = vertex;
      if (v < projected[minY * 2 + 1]) minY = vertex;
      if (v > projected[maxY * 2 + 1]) maxY = vertex;
      if (u + v < projected[minSum * 2] + projected[minSum * 2 + 1]) minSum = vertex;
      if (u + v > projected[maxSum * 2] + projected[maxSum * 2 + 1]) maxSum = vertex;
      if (u - v < projected[minDiff * 2] - projected[minDiff * 2 + 1]) minDiff = vertex;
      if (u - v > projected[maxDiff * 2] - projected[maxDiff * 2 + 1]) maxDiff = vertex;
    }
    candidates = Array.from(new Set([minX, maxX, minY, maxY, minSum, maxSum, minDiff, maxDiff]));
  }
  let best = -1;
  let bestA = -1;
  let bestB = -1;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      const du = projected[a * 2] - projected[b * 2];
      const dv = projected[a * 2 + 1] - projected[b * 2 + 1];
      const distance = du * du + dv * dv;
      if (distance > best) {
        best = distance;
        bestA = a;
        bestB = b;
      }
    }
  }
  if (best <= EPSILON || bestA < 0 || bestB < 0) return null;
  return [bestA, bestB];
}

function translateToOrigin(uvs: Float32Array): {
  minU: number; minV: number; maxU: number; maxV: number;
} {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let vertex = 0; vertex < uvs.length / 2; vertex += 1) {
    minU = Math.min(minU, uvs[vertex * 2]);
    minV = Math.min(minV, uvs[vertex * 2 + 1]);
    maxU = Math.max(maxU, uvs[vertex * 2]);
    maxV = Math.max(maxV, uvs[vertex * 2 + 1]);
  }
  for (let vertex = 0; vertex < uvs.length / 2; vertex += 1) {
    uvs[vertex * 2] -= minU;
    uvs[vertex * 2 + 1] -= minV;
  }
  return { minU: 0, minV: 0, maxU: maxU - minU, maxV: maxV - minV };
}

function projectedExtent(projected: Float32Array): { width: number; height: number } {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let vertex = 0; vertex < projected.length / 2; vertex += 1) {
    minU = Math.min(minU, projected[vertex * 2]);
    minV = Math.min(minV, projected[vertex * 2 + 1]);
    maxU = Math.max(maxU, projected[vertex * 2]);
    maxV = Math.max(maxV, projected[vertex * 2 + 1]);
  }
  return { width: maxU - minU, height: maxV - minV };
}

/** Orders the chart's boundary as a single loop of chart-local vertices. Each
 * chart border contributes one directed half-edge, so the two sides of a cut
 * remain distinct even though they share global vertices. */
function chartBoundaryLoop(
  chart: Chart,
  topology: MeshTopology,
): number[] | null {
  const boundaryEdges = new Set(chart.boundaryEdges);
  const next = new Map<number, number>();
  for (let local = 0; local < chart.triangles.length; local += 1) {
    const triangle = chart.triangles[local];
    for (let corner = 0; corner < 3; corner += 1) {
      const edge = topology.edgeOfTriangle[triangle * 3 + corner];
      if (edge < 0 || !boundaryEdges.has(edge)) continue;
      const a = chart.localIndices[local * 3 + corner];
      const b = chart.localIndices[local * 3 + ((corner + 1) % 3)];
      if (next.has(a)) return null;
      next.set(a, b);
    }
  }
  if (next.size < 3) return null;
  let start = -1;
  for (const key of next.keys()) {
    start = key;
    break;
  }
  const loop: number[] = [];
  let current = start;
  for (let step = 0; step < next.size; step += 1) {
    const following = next.get(current);
    if (following === undefined) return null;
    loop.push(current);
    current = following;
    if (current === start) break;
  }
  return current === start && loop.length === next.size ? loop : null;
}

function localDistance(mesh: ConditionedMesh, chart: Chart, a: number, b: number): number {
  const ga = chart.localVertex[a];
  const gb = chart.localVertex[b];
  return Math.hypot(
    mesh.positions[gb * 3] - mesh.positions[ga * 3],
    mesh.positions[gb * 3 + 1] - mesh.positions[ga * 3 + 1],
    mesh.positions[gb * 3 + 2] - mesh.positions[ga * 3 + 2],
  );
}

/** Tutte embedding for a disk chart: the single boundary loop is placed on a
 * circle in proportion to its edge lengths and the interior is solved as a
 * uniform harmonic function. A valid initial embedding lets LSCM unroll tubes
 * and cut spheres without a planar projection folding them first. */
function harmonicEmbedding(
  mesh: ConditionedMesh,
  chart: Chart,
  loop: number[],
  topology: MeshTopology,
): Float32Array | null {
  const vertexCount = chart.localVertex.length;
  if (loop.length < 3 || vertexCount < 3) return null;
  const boundary = new Uint8Array(vertexCount);
  for (const vertex of loop) boundary[vertex] = 1;

  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const length = localDistance(mesh, chart, loop[index], loop[(index + 1) % loop.length]);
    lengths.push(length);
    total += length;
  }
  const radius = Math.max(Math.sqrt(Math.max(chart.worldArea, 0) / Math.PI), 1e-6);
  const uvs = new Float32Array(vertexCount * 2);
  let cumulative = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const angle = total > EPSILON
      ? (Math.PI * 2 * cumulative) / total
      : (Math.PI * 2 * index) / loop.length;
    uvs[loop[index] * 2] = Math.cos(angle) * radius;
    uvs[loop[index] * 2 + 1] = Math.sin(angle) * radius;
    cumulative += lengths[index];
  }

  const adjacency: number[][] = Array.from({ length: vertexCount }, () => []);
  const seen = new Set<number>();
  const boundaryEdges = new Set(chart.boundaryEdges);
  for (let local = 0; local < chart.triangles.length; local += 1) {
    const triangle = chart.triangles[local];
    for (let corner = 0; corner < 3; corner += 1) {
      const edgeIndex = topology.edgeOfTriangle[triangle * 3 + corner];
      if (edgeIndex < 0 || boundaryEdges.has(edgeIndex)) continue;
      const edge = topology.edges[edgeIndex];
      if (edge.boundary || edge.nonManifold || edge.triangles.length !== 2) continue;
      const a = chart.localIndices[local * 3 + corner];
      const b = chart.localIndices[local * 3 + ((corner + 1) % 3)];
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      adjacency[a].push(b);
      adjacency[b].push(a);
    }
  }

  const freeOf = new Int32Array(vertexCount).fill(-1);
  const freeVertices: number[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (boundary[vertex]) continue;
    freeOf[vertex] = freeVertices.length;
    freeVertices.push(vertex);
    if (adjacency[vertex].length === 0) return null;
  }
  const freeCount = freeVertices.length;
  if (freeCount === 0) return uvs;

  const degree = new Float64Array(freeCount);
  for (let free = 0; free < freeCount; free += 1) {
    degree[free] = adjacency[freeVertices[free]].length;
  }
  const system = {
    size: freeCount,
    diagonal: degree,
    apply(x: Float64Array, out: Float64Array): void {
      for (let free = 0; free < freeCount; free += 1) {
        const vertex = freeVertices[free];
        let value = degree[free] * x[free];
        for (const neighbor of adjacency[vertex]) {
          const neighborFree = freeOf[neighbor];
          if (neighborFree >= 0) value -= x[neighborFree];
        }
        out[free] = value;
      }
    },
  };

  for (let axis = 0; axis < 2; axis += 1) {
    const rhs = new Float64Array(freeCount);
    for (let free = 0; free < freeCount; free += 1) {
      let value = 0;
      for (const neighbor of adjacency[freeVertices[free]]) {
        if (freeOf[neighbor] < 0) value += uvs[neighbor * 2 + axis];
      }
      rhs[free] = value;
    }
    const solved = solveConjugateGradient(
      system,
      rhs,
      new Float64Array(freeCount),
      { tolerance: 1e-9, maxIterations: Math.min(4 * freeCount, 2000) },
    );
    if (!solved.converged && solved.residual > 1e-4) return null;
    for (let free = 0; free < freeCount; free += 1) {
      if (!Number.isFinite(solved.x[free])) return null;
      uvs[freeVertices[free] * 2 + axis] = solved.x[free];
    }
  }
  return uvs;
}

/** Intrinsic per-triangle coordinates from edge lengths. LSCM only needs each
 * triangle's local shape; a global projection of a curved chart is not
 * required and would bias the solve. */
function intrinsicTriangles(mesh: ConditionedMesh, chart: Chart): LscmTriangle[] {
  const triangles: LscmTriangle[] = [];
  for (let local = 0; local < chart.triangles.length; local += 1) {
    const triangle = chart.triangles[local];
    const ia = mesh.indices[triangle * 3];
    const ib = mesh.indices[triangle * 3 + 1];
    const ic = mesh.indices[triangle * 3 + 2];
    const ax = mesh.positions[ia * 3];
    const ay = mesh.positions[ia * 3 + 1];
    const az = mesh.positions[ia * 3 + 2];
    const bx = mesh.positions[ib * 3];
    const by = mesh.positions[ib * 3 + 1];
    const bz = mesh.positions[ib * 3 + 2];
    const cx = mesh.positions[ic * 3];
    const cy = mesh.positions[ic * 3 + 1];
    const cz = mesh.positions[ic * 3 + 2];
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    const length1 = Math.hypot(e1x, e1y, e1z);
    if (length1 <= EPSILON) continue;
    const dot12 = e2x * e1x + e2y * e1y + e2z * e1z;
    const x2 = dot12 / length1;
    const y2 = Math.sqrt(Math.max(0, e2x * e2x + e2y * e2y + e2z * e2z - x2 * x2));
    if (y2 <= EPSILON) continue;
    triangles.push({
      a: chart.localIndices[local * 3],
      b: chart.localIndices[local * 3 + 1],
      c: chart.localIndices[local * 3 + 2],
      ax: 0,
      ay: 0,
      bx: length1,
      by: 0,
      cx: x2,
      cy: y2,
    });
  }
  return triangles;
}

function failedChart(chart: Chart, failure: ChartFailure): ChartUv {
  return {
    chart: chart.id,
    triangles: chart.triangles,
    localIndices: chart.localIndices,
    localVertex: chart.localVertex,
    uvs: new Float32Array(chart.localVertex.length * 2),
    worldArea: chart.worldArea,
    uvArea: 0,
    bbox: { minU: 0, minV: 0, maxU: 0, maxV: 0 },
    solverIterations: 0,
    solverResidual: 0,
    solverConverged: false,
    initialization: 'none',
    failed: true,
    failure,
  };
}

function failureMessage(failure: ChartFailure | null): string {
  switch (failure) {
    case 'degenerate':
      return 'the chart has no usable surface area.';
    case 'not-disk':
      return 'the chart is not a disk and has to be cut open first.';
    case 'no-boundary-loop':
      return 'the chart boundary could not be traced as a single loop.';
    case 'embedding-failed':
      return 'the harmonic boundary embedding could not be solved.';
    case 'solve-diverged':
      return 'the LSCM solve did not converge to a finite layout.';
    case 'folded-solution':
      return 'the LSCM layout folds over itself.';
    default:
      return 'the cause is unknown.';
  }
}

/** Clips a convex polygon against the half plane left of the directed line
 * (x0,y0)->(x1,y1). Points are flat [x0,y0,x1,y1,...] values. */
function clipHalfPlane(
  polygon: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number[] {
  const out: number[] = [];
  const count = polygon.length / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  for (let index = 0; index < count; index += 1) {
    const px = polygon[index * 2];
    const py = polygon[index * 2 + 1];
    const next = (index + 1) % count;
    const qx = polygon[next * 2];
    const qy = polygon[next * 2 + 1];
    const sideP = dx * (py - y0) - dy * (px - x0);
    const sideQ = dx * (qy - y0) - dy * (qx - x0);
    if (sideP >= 0) out.push(px, py);
    if ((sideP > 0 && sideQ < 0) || (sideP < 0 && sideQ > 0)) {
      const t = sideP / (sideP - sideQ);
      out.push(px + t * (qx - px), py + t * (qy - py));
    }
  }
  return out;
}

/** Shared area of two counter-clockwise triangles, clamped to zero for pairs
 * that only touch along an edge or a vertex. */
function triangleOverlapArea(
  a: Float32Array,
  b: Float32Array,
  tolerance: number,
): number {
  let polygon = [a[0], a[1], a[2], a[3], a[4], a[5]];
  for (let edge = 0; edge < 3; edge += 1) {
    const next = (edge + 1) % 3;
    polygon = clipHalfPlane(
      polygon,
      b[edge * 2],
      b[edge * 2 + 1],
      b[next * 2],
      b[next * 2 + 1],
    );
    if (polygon.length < 6) return 0;
  }
  let sum = 0;
  const count = polygon.length / 2;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    sum += polygon[index * 2] * polygon[next * 2 + 1]
      - polygon[next * 2] * polygon[index * 2 + 1];
  }
  const area = Math.abs(sum) * 0.5;
  return area > tolerance ? area : 0;
}

/** Sets a flag on every triangle that overlaps a non-adjacent triangle.
 * Triangles that meet on a shared edge produce exactly zero overlap area, so
 * they never count. */
function markLayoutFolds(
  uvs: Float32Array,
  localIndices: Uint32Array,
  bbox: { minU: number; minV: number; maxU: number; maxV: number },
  minFoldArea: number,
  folded: Uint8Array,
): void {
  const triangleCount = localIndices.length / 3;
  if (triangleCount < 2) return;
  const width = bbox.maxU - bbox.minU;
  const height = bbox.maxV - bbox.minV;
  if (!(width > 0) || !(height > 0)) return;
  const tolerance = 1e-10 * width * height;
  const cornerUv = new Float32Array(triangleCount * 6);
  const boxes = new Float64Array(triangleCount * 4);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = localIndices[triangle * 3 + corner] * 2;
      const u = uvs[vertex];
      const v = uvs[vertex + 1];
      cornerUv[triangle * 6 + corner * 2] = u;
      cornerUv[triangle * 6 + corner * 2 + 1] = v;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    boxes[triangle * 4] = minU;
    boxes[triangle * 4 + 1] = minV;
    boxes[triangle * 4 + 2] = maxU;
    boxes[triangle * 4 + 3] = maxV;
  }

  const order = new Uint32Array(triangleCount);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) order[triangle] = triangle;
  order.sort((a, b) => boxes[a * 4] - boxes[b * 4]);

  for (let i = 0; i < triangleCount; i += 1) {
    const a = order[i];
    const aBox = a * 4;
    const aTri = cornerUv.subarray(a * 6, a * 6 + 6) as Float32Array;
    for (let j = i + 1; j < triangleCount; j += 1) {
      const b = order[j];
      const bBox = b * 4;
      if (boxes[bBox] > boxes[aBox + 2]) break;
      if (boxes[bBox + 1] > boxes[aBox + 3] || boxes[bBox + 3] < boxes[aBox + 1]) continue;
      if (boxes[bBox + 2] < boxes[aBox]) continue;
      const bTri = cornerUv.subarray(b * 6, b * 6 + 6) as Float32Array;
      const overlap = triangleOverlapArea(aTri, bTri, tolerance);
      if (overlap <= 0 || overlap < minFoldArea) continue;
      folded[a] = 1;
      folded[b] = 1;
    }
  }
}

/** Flattens one chart or reports why it cannot be flattened. Curved charts
 * need disk topology: a closed chart or one with extra boundary loops is
 * reported instead of being forced through a planar projection. */
function parameterizeChart(
  mesh: ConditionedMesh,
  chart: Chart,
  face: FaceGeometry,
  topology: MeshTopology,
  options: ParameterizeOptions,
): ChartUv {
  const projected = projectChart(mesh, chart, face);
  if (!projected) return failedChart(chart, 'degenerate');
  if (projected.planar && Math.abs(projected.signedArea) > EPSILON) {
    const uvs = Float32Array.from(projected.projected);
    const bbox = translateToOrigin(uvs);
    return {
      chart: chart.id,
      triangles: chart.triangles,
      localIndices: chart.localIndices,
      localVertex: chart.localVertex,
      uvs,
      worldArea: chart.worldArea,
      uvArea: Math.abs(chartSignedArea(uvs, chart.localIndices)),
      bbox,
      solverIterations: 0,
      solverResidual: 0,
      solverConverged: true,
      initialization: 'projection',
      failed: false,
      failure: null,
    };
  }

  if (chart.closed || chart.boundaryComponents !== 1) return failedChart(chart, 'not-disk');
  const loop = chartBoundaryLoop(chart, topology);
  if (!loop) return failedChart(chart, 'no-boundary-loop');
  let initial = harmonicEmbedding(mesh, chart, loop, topology);
  if (!initial) return failedChart(chart, 'embedding-failed');
  if (chartSignedArea(initial, chart.localIndices) < 0) initial = mirrorU(initial);
  if (!(chartSignedArea(initial, chart.localIndices) > EPSILON)) {
    return failedChart(chart, 'embedding-failed');
  }

  const extent = projectedExtent(initial);
  const scale = Math.max(extent.width, extent.height);
  const pins = choosePins(initial, chart.localVertex.length);
  const triangles = intrinsicTriangles(mesh, chart);
  if (!(scale > EPSILON) || !pins || triangles.length === 0) {
    return failedChart(chart, 'solve-diverged');
  }
  const normalized = new Float32Array(initial.length);
  for (let value = 0; value < normalized.length; value += 1) {
    normalized[value] = initial[value] / scale;
  }
  const solved = solveLscm(
    chart.localVertex.length,
    triangles,
    normalized,
    pins[0],
    pins[1],
    { tolerance: options.tolerance, maxIterations: options.maxIterations },
  );
  if (!Number.isFinite(solved.residual)) return failedChart(chart, 'solve-diverged');
  const uvs = new Float32Array(solved.uvs.length);
  for (let value = 0; value < solved.uvs.length; value += 1) {
    uvs[value] = solved.uvs[value] * scale;
  }
  if (chartSignedArea(uvs, chart.localIndices) < 0) return failedChart(chart, 'folded-solution');
  const triangleCount = chart.localIndices.length / 3;
  const bbox = translateToOrigin(uvs);
  const density = options.texelDensity ?? 0;
  const minFoldArea = density > 0 ? 1 / (density * density) : 0;
  const folded = new Uint8Array(triangleCount);
  markLayoutFolds(uvs, chart.localIndices, bbox, minFoldArea, folded);
  const failedFaces: number[] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = chart.localIndices[triangle * 3] * 2;
    const b = chart.localIndices[triangle * 3 + 1] * 2;
    const c = chart.localIndices[triangle * 3 + 2] * 2;
    if (signedTriangleArea2D(
      uvs[a], uvs[a + 1],
      uvs[b], uvs[b + 1],
      uvs[c], uvs[c + 1],
    ) <= EPSILON) {
      folded[triangle] = 1;
    }
    if (folded[triangle]) failedFaces.push(triangle);
  }
  const allowed = options.maxFlippedFraction ?? 0;
  if (triangleCount === 0 || failedFaces.length / triangleCount > allowed) {
    return failedChart(chart, 'folded-solution');
  }
  return {
    chart: chart.id,
    triangles: chart.triangles,
    localIndices: chart.localIndices,
    localVertex: chart.localVertex,
    uvs,
    worldArea: chart.worldArea,
    uvArea: Math.abs(chartSignedArea(uvs, chart.localIndices)),
    bbox,
    solverIterations: solved.iterations,
    solverResidual: solved.residual,
    solverConverged: solved.converged,
    initialization: 'harmonic',
    failed: false,
    failure: null,
  };
}

function sourceChart(mesh: ConditionedMesh, chart: Chart): ChartUv | null {
  const source = mesh.triangleUvs;
  if (!source) return null;
  const uvs = new Float32Array(chart.localVertex.length * 2);
  const seen = new Uint8Array(chart.localVertex.length);
  for (let local = 0; local < chart.triangles.length; local += 1) {
    const triangle = chart.triangles[local];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = chart.localIndices[local * 3 + corner];
      if (seen[vertex]) continue;
      const offset = triangle * 6 + corner * 2;
      const u = source[offset];
      const v = source[offset + 1];
      if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
      uvs[vertex * 2] = u;
      uvs[vertex * 2 + 1] = v;
      seen[vertex] = 1;
    }
  }
  const bbox = translateToOrigin(uvs);
  return {
    chart: chart.id,
    triangles: chart.triangles,
    localIndices: chart.localIndices,
    localVertex: chart.localVertex,
    uvs,
    worldArea: chart.worldArea,
    uvArea: Math.abs(chartSignedArea(uvs, chart.localIndices)),
    bbox,
    solverIterations: 0,
    solverResidual: 0,
    solverConverged: true,
    initialization: 'source',
    failed: false,
    failure: null,
  };
}

/** Flattens every chart, then measures angle and area distortion in global
 * triangle order. Planar charts copy their projection directly; curved disk
 * charts start from a harmonic boundary embedding and refine with LSCM. */
export function parameterizeMesh(
  mesh: ConditionedMesh,
  segmentation: Segmentation,
  face: FaceGeometry,
  topology: MeshTopology,
  options: ParameterizeOptions = {},
): ParameterizeResult {
  const charts = segmentation.charts.map((chart) => (
    options.sourceUvs && mesh.triangleUvs
      ? sourceChart(mesh, chart) ?? parameterizeChart(mesh, chart, face, topology, options)
      : parameterizeChart(mesh, chart, face, topology, options)
  ));
  const triangleUvs = new Float32Array(mesh.triangleCount * 6);
  for (const chart of charts) {
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const triangle = chart.triangles[local];
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = chart.localIndices[local * 3 + corner];
        triangleUvs[triangle * 6 + corner * 2] = chart.uvs[vertex * 2];
        triangleUvs[triangle * 6 + corner * 2 + 1] = chart.uvs[vertex * 2 + 1];
      }
    }
  }

  const flattened = charts.filter((chart) => !chart.failed);
  const metrics = computeFaceMetrics(mesh, flattened, triangleUvs);
  const angleSummary = summarize(metrics.angleDistortion);
  const areaSummary = summarize(metrics.areaDistortion);
  let flipped = 0;
  for (const value of metrics.flipped) flipped += value;
  const failedCharts = charts.filter((chart) => chart.failed).length;
  const harmonicCharts = charts.filter((chart) => chart.initialization === 'harmonic').length;
  const solverFailures = charts.filter((chart) => !chart.failed && !chart.solverConverged).length;
  let solverIterationsMax = 0;
  let solverResidualMax = 0;
  let uvAreaTotal = 0;
  for (const chart of charts) {
    solverIterationsMax = Math.max(solverIterationsMax, chart.solverIterations);
    if (Number.isFinite(chart.solverResidual)) {
      solverResidualMax = Math.max(solverResidualMax, chart.solverResidual);
    }
    uvAreaTotal += chart.uvArea;
  }

  const issues: Issue[] = [];
  for (const chart of charts) {
    if (!chart.failed) continue;
    issues.push({
      stage: 'parameterize',
      severity: 'error',
      chart: chart.chart,
      code: 'chart-flatten-failed',
      message: `Chart ${chart.chart} could not be flattened: ${failureMessage(chart.failure)}`,
      value: 1,
    });
  }
  if (flipped > 0) {
    issues.push({
      stage: 'parameterize',
      severity: 'warn',
      code: 'flipped-triangles',
      message: `${flipped} triangle${flipped === 1 ? '' : 's'} are flipped in UV space.`,
      value: flipped,
    });
  }
  if (angleSummary.p95 > 20) {
    issues.push({
      stage: 'parameterize',
      severity: 'warn',
      code: 'high-angle-distortion',
      message: `Angle distortion p95 is ${angleSummary.p95.toFixed(2)} degrees.`,
      value: Number(angleSummary.p95.toFixed(3)),
      threshold: 20,
    });
  }
  if (solverFailures > 0) {
    issues.push({
      stage: 'parameterize',
      severity: 'warn',
      code: 'solver-failures',
      message: `${solverFailures} chart solve${solverFailures === 1 ? '' : 's'} did not converge.`,
      value: solverFailures,
    });
  }
  if (charts.length === 0) {
    issues.push({
      stage: 'parameterize',
      severity: 'error',
      code: 'no-charts',
      message: 'No charts were available to parameterize.',
    });
  }

  const stats: StageStats = {
    charts: charts.length,
    angleP50: Number(angleSummary.p50.toFixed(4)),
    angleP95: Number(angleSummary.p95.toFixed(4)),
    angleMax: Number(angleSummary.max.toFixed(4)),
    areaP50: Number(areaSummary.p50.toFixed(4)),
    areaP95: Number(areaSummary.p95.toFixed(4)),
    areaMax: Number(areaSummary.max.toFixed(4)),
    flipped,
    failedCharts,
    harmonicCharts,
    solverFailures,
    solverIterationsMax,
    solverResidualMax: Number(solverResidualMax.toFixed(8)),
    uvAreaTotal: Number(uvAreaTotal.toFixed(6)),
    worldAreaTotal: Number(segmentation.charts.reduce((sum, chart) => sum + chart.worldArea, 0).toFixed(6)),
  };

  return {
    charts,
    triangleUvs,
    angleDistortion: metrics.angleDistortion,
    areaDistortion: metrics.areaDistortion,
    flipped: metrics.flipped,
    stats,
    issues,
  };
}
