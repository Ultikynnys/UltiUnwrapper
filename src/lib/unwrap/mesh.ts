import type {
  ConditionOptions,
  ConditionResult,
  ConditionedMesh,
  Issue,
  RawMesh,
  StageStats,
  Vec3,
} from './types';

const DEFAULT_WELD_EPSILON = 1e-5;
const AREA_EPSILON = 1e-12;

export type WeldResult = {
  positions: Float32Array;
  sourceVertex: Uint32Array;
  /** Raw vertex index -> welded vertex index. */
  map: Uint32Array;
  merged: number;
};

export type FaceGeometry = {
  /** Unit face normals, 3 floats per triangle. */
  normals: Float32Array;
  /** Triangle areas, 1 float per triangle. */
  areas: Float32Array;
};

export function boundsOf(positions: Float32Array): { min: Vec3; max: Vec3; diagonal: number } {
  if (positions.length < 3) {
    return { min: [0, 0, 0], max: [0, 0, 0], diagonal: 0 };
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return { min, max, diagonal: Number.isFinite(diagonal) ? diagonal : 0 };
}

/** Welds vertices whose positions are within `epsilon` of an earlier vertex.
 * A spatial hash checks the 27 neighboring cells, so duplicates that straddle
 * a cell boundary still merge. The first vertex of a cluster keeps its
 * position, which makes the result deterministic. */
export function weldVertices(positions: Float32Array, epsilon: number): WeldResult {
  const count = Math.floor(positions.length / 3);
  const map = new Uint32Array(count);
  if (count === 0) {
    return { positions: new Float32Array(0), sourceVertex: new Uint32Array(0), map, merged: 0 };
  }

  const eps = Math.max(epsilon, 0);
  const cellSize = eps > 0 ? eps : 1;
  const inverse = 1 / cellSize;
  const epsilonSquared = eps * eps;
  const buckets = new Map<string, number[]>();
  const weldedPositions: number[] = [];
  const sourceVertex: number[] = [];

  const cellKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      map[i] = 0;
      continue;
    }
    const cx = Math.floor(x * inverse);
    const cy = Math.floor(y * inverse);
    const cz = Math.floor(z * inverse);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx += 1) {
      for (let dy = -1; dy <= 1 && found < 0; dy += 1) {
        for (let dz = -1; dz <= 1 && found < 0; dz += 1) {
          const bucket = buckets.get(cellKey(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const candidate of bucket) {
            const px = weldedPositions[candidate * 3];
            const py = weldedPositions[candidate * 3 + 1];
            const pz = weldedPositions[candidate * 3 + 2];
            const ddx = x - px;
            const ddy = y - py;
            const ddz = z - pz;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= epsilonSquared) {
              found = candidate;
              break;
            }
          }
        }
      }
    }
    if (found < 0) {
      found = sourceVertex.length;
      weldedPositions.push(x, y, z);
      sourceVertex.push(i);
      const key = cellKey(cx, cy, cz);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(found);
      else buckets.set(key, [found]);
    }
    map[i] = found;
  }

  return {
    positions: new Float32Array(weldedPositions),
    sourceVertex: new Uint32Array(sourceVertex),
    map,
    merged: count - sourceVertex.length,
  };
}

export function faceAreaAt(mesh: ConditionedMesh, triangle: number): number {
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
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return 0.5 * Math.hypot(nx, ny, nz);
}

export function faceNormalAt(mesh: ConditionedMesh, triangle: number, out: Vec3): Vec3 {
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
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length <= 1e-15) {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
    return out;
  }
  out[0] = nx / length;
  out[1] = ny / length;
  out[2] = nz / length;
  return out;
}

export function triangleNormal(mesh: ConditionedMesh, triangle: number): Vec3 {
  return faceNormalAt(mesh, triangle, [0, 0, 0]);
}

export function computeFaceGeometry(mesh: ConditionedMesh): FaceGeometry {
  const normals = new Float32Array(mesh.triangleCount * 3);
  const areas = new Float32Array(mesh.triangleCount);
  const normal: Vec3 = [0, 0, 0];
  for (let tri = 0; tri < mesh.triangleCount; tri += 1) {
    faceNormalAt(mesh, tri, normal);
    normals[tri * 3] = normal[0];
    normals[tri * 3 + 1] = normal[1];
    normals[tri * 3 + 2] = normal[2];
    areas[tri] = faceAreaAt(mesh, tri);
  }
  return { normals, areas };
}

function computeVertexNormals(mesh: ConditionedMesh, face: FaceGeometry): Float32Array {
  const normals = new Float32Array(mesh.vertexCount * 3);
  for (let tri = 0; tri < mesh.triangleCount; tri += 1) {
    const weight = face.areas[tri];
    const nx = face.normals[tri * 3] * weight;
    const ny = face.normals[tri * 3 + 1] * weight;
    const nz = face.normals[tri * 3 + 2] * weight;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = mesh.indices[tri * 3 + corner];
      normals[vertex * 3] += nx;
      normals[vertex * 3 + 1] += ny;
      normals[vertex * 3 + 2] += nz;
    }
  }
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    const x = normals[vertex * 3];
    const y = normals[vertex * 3 + 1];
    const z = normals[vertex * 3 + 2];
    const length = Math.hypot(x, y, z);
    if (length > 1e-15) {
      normals[vertex * 3] = x / length;
      normals[vertex * 3 + 1] = y / length;
      normals[vertex * 3 + 2] = z / length;
    } else {
      normals[vertex * 3 + 1] = 1;
    }
  }
  return normals;
}

function emptyMesh(raw: RawMesh): ConditionedMesh {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    objectOfTriangle: new Uint32Array(0),
    materialOfTriangle: new Int32Array(0),
    sourceTriangle: new Uint32Array(0),
    sourceVertex: new Uint32Array(0),
    objectNames: raw.objectNames,
    vertexCount: 0,
    triangleCount: 0,
  };
}

/** Converts a flattened scene into a welded, degenerate-free mesh with
 * area-weighted vertex normals. Invalid triangles are dropped and counted;
 * an empty result is reported as an error issue rather than throwing. */
export function conditionMesh(raw: RawMesh, options: Partial<ConditionOptions> = {}): ConditionResult {
  const issues: Issue[] = [];
  const inputVertexCount = Math.floor(raw.positions.length / 3);
  const inputTriangleCount = Math.floor(raw.indices.length / 3);
  const bounds = boundsOf(raw.positions);
  const weldEpsilon = options.weldEpsilon ?? DEFAULT_WELD_EPSILON;
  const epsilon = Math.max(bounds.diagonal * weldEpsilon, 1e-9);
  const welded = weldVertices(raw.positions, epsilon);

  if (inputTriangleCount === 0 || welded.positions.length === 0) {
    issues.push({
      stage: 'condition',
      severity: 'error',
      code: 'empty-mesh',
      message: 'The mesh has no triangles to unwrap.',
    });
    return {
      mesh: emptyMesh(raw),
      stats: {
        inputVertices: inputVertexCount,
        weldedVertices: 0,
        inputTriangles: inputTriangleCount,
        triangles: 0,
        degenerateRemoved: 0,
        duplicateVertices: welded.merged,
        bounds: '0 x 0 x 0',
      },
      issues,
    };
  }

  const keptTriangles: number[] = [];
  const objectOfTriangle: number[] = [];
  const materialOfTriangle: number[] = [];
  const sourceTriangle: number[] = [];
  let degenerateRemoved = 0;
  const areaEpsilon = Math.max(AREA_EPSILON, bounds.diagonal * bounds.diagonal * 1e-12);

  for (let tri = 0; tri < inputTriangleCount; tri += 1) {
    const rawA = raw.indices[tri * 3];
    const rawB = raw.indices[tri * 3 + 1];
    const rawC = raw.indices[tri * 3 + 2];
    if (rawA >= inputVertexCount || rawB >= inputVertexCount || rawC >= inputVertexCount) {
      degenerateRemoved += 1;
      continue;
    }
    const a = welded.map[rawA];
    const b = welded.map[rawB];
    const c = welded.map[rawC];
    if (a === b || b === c || c === a) {
      degenerateRemoved += 1;
      continue;
    }
    const ax = welded.positions[a * 3];
    const ay = welded.positions[a * 3 + 1];
    const az = welded.positions[a * 3 + 2];
    const bx = welded.positions[b * 3];
    const by = welded.positions[b * 3 + 1];
    const bz = welded.positions[b * 3 + 2];
    const cx = welded.positions[c * 3];
    const cy = welded.positions[c * 3 + 1];
    const cz = welded.positions[c * 3 + 2];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (0.5 * Math.hypot(nx, ny, nz) <= areaEpsilon) {
      degenerateRemoved += 1;
      continue;
    }
    keptTriangles.push(a, b, c);
    objectOfTriangle.push(raw.objectOfTriangle[tri] ?? 0);
    materialOfTriangle.push(raw.materialOfTriangle[tri] ?? -1);
    sourceTriangle.push(raw.sourceTriangle[tri] ?? tri);
  }

  const triangleCount = keptTriangles.length / 3;
  if (triangleCount === 0) {
    issues.push({
      stage: 'condition',
      severity: 'error',
      code: 'empty-mesh',
      message: 'Every triangle was degenerate or invalid.',
    });
    return {
      mesh: emptyMesh(raw),
      stats: {
        inputVertices: inputVertexCount,
        weldedVertices: welded.sourceVertex.length,
        inputTriangles: inputTriangleCount,
        triangles: 0,
        degenerateRemoved,
        duplicateVertices: welded.merged,
        bounds: '0 x 0 x 0',
      },
      issues,
    };
  }

  const mesh: ConditionedMesh = {
    positions: welded.positions,
    normals: new Float32Array(welded.positions.length),
    indices: new Uint32Array(keptTriangles),
    objectOfTriangle: new Uint32Array(objectOfTriangle),
    materialOfTriangle: new Int32Array(materialOfTriangle),
    sourceTriangle: new Uint32Array(sourceTriangle),
    sourceVertex: welded.sourceVertex,
    objectNames: raw.objectNames,
    vertexCount: welded.sourceVertex.length,
    triangleCount,
  };
  mesh.normals = computeVertexNormals(mesh, computeFaceGeometry(mesh));

  if (degenerateRemoved > 0) {
    issues.push({
      stage: 'condition',
      severity: 'info',
      code: 'degenerate-removed',
      message: `${degenerateRemoved} degenerate or invalid triangle${degenerateRemoved === 1 ? '' : 's'} removed.`,
      value: degenerateRemoved,
    });
  }
  if (welded.merged > 0) {
    issues.push({
      stage: 'condition',
      severity: 'info',
      code: 'duplicate-vertices',
      message: `${welded.merged} duplicate vertex${welded.merged === 1 ? '' : 'es'} welded by position.`,
      value: welded.merged,
    });
  }

  const stats: StageStats = {
    inputVertices: inputVertexCount,
    weldedVertices: mesh.vertexCount,
    inputTriangles: inputTriangleCount,
    triangles: mesh.triangleCount,
    degenerateRemoved,
    duplicateVertices: welded.merged,
    bounds: `${(bounds.max[0] - bounds.min[0]).toFixed(3)} x ${(bounds.max[1] - bounds.min[1]).toFixed(3)} x ${(bounds.max[2] - bounds.min[2]).toFixed(3)}`,
  };

  return { mesh, stats, issues };
}
