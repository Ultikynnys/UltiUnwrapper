import { percentile, signedTriangleArea2D } from './metrics';
import { chartFaceDensities } from './density';
import { computeSeams } from './seams';
import type { SeamResult } from './seams';
import { detectSymmetry } from './symmetry';
import type { MirrorPlane, SymmetryResult } from './symmetry';
import { nowEpoch } from './clock';
import type { FaceGeometry } from './mesh';
import type {
  ChartLayout,
  ChartUv,
  ConditionedMesh,
  Issue,
  MeshTopology,
  StageStats,
} from './types';

const AREA_EPSILON = 1e-12;
/** Share of the unit square the fitted islands may occupy before packing gaps. */
export const SMART_FIT_AREA_TARGET = 0.6;
const DEG_TO_RAD = Math.PI / 180;
/** Above this face count the portfolio keeps two growth variants to bound
 * base-construction cost. */
export const SMART_PORTFOLIO_FACE_LIMIT = 30_000;
export const DENSITY_SPREAD_MARGIN = 1e-4;
export const SMART_GROWTH_SCALES = [0.35, 0.5, 0.7] as const;
const SMART_GROWTH_SCALES_LARGE = [0.35, 0.5] as const;
/** FLT_EPSILON, matching the reference basis construction. */
const FLOAT_EPSILON = 1.1920929e-7;

export type SmartProjectOptions = {
  /** Faces whose normals fall within this angle of a projection share it. */
  angleLimit: number;
  /** 0 = unweighted normal average, 1 = area-weighted, between = blend. */
  areaWeight: number;
};

export type SmartProjectionResult = {
  /** 3 floats per projection axis. */
  projections: Float32Array;
  projectionCount: number;
  /** Projection index per face, -1 for faces below the area threshold. */
  projectionOfFace: Int32Array;
  /** 6 floats per triangle in projected world units. */
  triangleUvs: Float32Array;
  stats: StageStats;
  issues: Issue[];
};

export type SmartIslandOptions = {
  splitByObject: boolean;
  splitByMaterial: boolean;
  /** Largest allowed texel-density variation inside one island. */
  maxDensitySpread?: number;
  /** Time budget for density cuts and island merging, in milliseconds. */
  budgetMs?: number;
  /** Fraction of the projection angle used for island growth. 0.5 preserves
   * the balanced default; lower values cut more, higher values cut less. */
  growthScale?: number;
  /** Optional mirror detection whose on-plane edges become chart seams. */
  symmetry?: SymmetryResult | null;
};

export type SmartIslandResult = {
  charts: ChartUv[];
  chartOfTriangle: Uint32Array;
  /** 1 for every chart border edge, including model boundaries. */
  seamEdge: Uint8Array;
  /** 6 floats per triangle, projected world units. */
  triangleUvs: Float32Array;
  stats: StageStats;
  issues: Issue[];
};

export type SmartFitResult = {
  scale: number;
  charts: ChartUv[];
  triangleUvs: Float32Array;
};

function normalDot(
  normals: Float32Array,
  face: number,
  axis: ArrayLike<number>,
  offset = 0,
): number {
  return normals[face * 3] * axis[offset]
    + normals[face * 3 + 1] * axis[offset + 1]
    + normals[face * 3 + 2] * axis[offset + 2];
}

/** Orthonormal 2D basis for a projection axis. The first vector stays
 * horizontal, the second is axis x first, so UV winding follows the axis. */
function orthoBasis(
  axis: ArrayLike<number>,
  offset: number,
): [number, number, number, number, number, number] {
  const nx = axis[offset];
  const ny = axis[offset + 1];
  const nz = axis[offset + 2];
  const planar = nx * nx + ny * ny;
  let ux: number;
  let uy: number;
  let uz: number;
  let vx: number;
  let vy: number;
  let vz: number;
  if (planar > FLOAT_EPSILON) {
    const inverse = 1 / Math.sqrt(planar);
    ux = ny * inverse;
    uy = -nx * inverse;
    uz = 0;
    vx = -nz * uy;
    vy = nz * ux;
    vz = nx * uy - ny * ux;
  } else {
    ux = nz < 0 ? -1 : 1;
    uy = 0;
    uz = 0;
    vx = 0;
    vy = 1;
    vz = 0;
  }
  return [ux, uy, uz, vx, vy, vz];
}

/** Splits faces into projection groups by clustering normals, then projects
 * every face onto its group's dominant plane. */
export function projectSmart(
  mesh: ConditionedMesh,
  face: FaceGeometry,
  options: SmartProjectOptions,
): SmartProjectionResult {
  const count = mesh.triangleCount;
  const normals = face.normals;
  const projectionOfFace = new Int32Array(count).fill(-1);
  const triangleUvs = new Float32Array(count * 6);
  const issues: Issue[] = [];

  const order: number[] = [];
  let zeroAreaFaces = 0;
  for (let triangle = 0; triangle < count; triangle += 1) {
    if (face.areas[triangle] > AREA_EPSILON) order.push(triangle);
    else zeroAreaFaces += 1;
  }
  order.sort((a, b) => face.areas[b] - face.areas[a] || a - b);

  const angleLimit = Math.max(0, Math.min(180, options.angleLimit));
  const areaWeight = Math.max(0, Math.min(1, options.areaWeight));
  const halfCos = Math.cos((angleLimit / 2) * DEG_TO_RAD);
  const fullCos = Math.cos(angleLimit * DEG_TO_RAD);

  const projections: number[] = [];
  if (order.length > 0) {
    const tagged = new Uint8Array(count);
    let seed = order[0];
    let pending: number[] = [];
    for (let guard = 0; guard <= order.length; guard += 1) {
      const group = pending;
      pending = [];
      for (let index = order.length - 1; index >= 0; index -= 1) {
        const triangle = order[index];
        if (tagged[triangle]) continue;
        if (normalDot(normals, triangle, normals, seed * 3) > halfCos) {
          tagged[triangle] = 1;
          group.push(triangle);
        }
      }
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const triangle of group) {
        const weight = areaWeight <= 0
          ? 1
          : areaWeight >= 1
            ? face.areas[triangle]
            : face.areas[triangle] * areaWeight + (1 - areaWeight);
        sx += normals[triangle * 3] * weight;
        sy += normals[triangle * 3 + 1] * weight;
        sz += normals[triangle * 3 + 2] * weight;
      }
      const length = Math.hypot(sx, sy, sz);
      if (length > 0) projections.push(sx / length, sy / length, sz / length);
      let bestDot = 1;
      let bestTriangle = -1;
      for (let index = order.length - 1; index >= 0; index -= 1) {
        const triangle = order[index];
        if (tagged[triangle]) continue;
        let maxDot = -1;
        for (let axis = 0; axis < projections.length; axis += 3) {
          const dot = normalDot(normals, triangle, projections, axis);
          if (dot > maxDot) maxDot = dot;
        }
        if (maxDot < bestDot) {
          bestDot = maxDot;
          bestTriangle = triangle;
        }
      }
      if (bestTriangle >= 0 && bestDot < fullCos) {
        seed = bestTriangle;
        tagged[seed] = 1;
        pending = [seed];
      } else {
        break;
      }
    }
  }

  const projectionCount = projections.length / 3;
  if (projectionCount === 0) {
    if (count > 0) {
      issues.push({
        stage: 'project',
        severity: 'error',
        code: 'no-projections',
        message: 'No projection axis could be generated from the face normals.',
      });
    }
  } else {
    let dotSum = 0;
    let dotMin = Infinity;
    for (const triangle of order) {
      let best = 0;
      let bestDot = -Infinity;
      for (let axis = 0; axis < projections.length; axis += 3) {
        const dot = normalDot(normals, triangle, projections, axis);
        if (dot > bestDot) {
          bestDot = dot;
          best = axis / 3;
        }
      }
      projectionOfFace[triangle] = best;
      dotSum += bestDot;
      if (bestDot < dotMin) dotMin = bestDot;

      const [ux, uy, uz, vx, vy, vz] = orthoBasis(projections, best * 3);
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = mesh.indices[triangle * 3 + corner];
        const x = mesh.positions[vertex * 3];
        const y = mesh.positions[vertex * 3 + 1];
        const z = mesh.positions[vertex * 3 + 2];
        triangleUvs[triangle * 6 + corner * 2] = x * ux + y * uy + z * uz;
        triangleUvs[triangle * 6 + corner * 2 + 1] = x * vx + y * vy + z * vz;
      }
    }
    const meanDot = order.length > 0 ? dotSum / order.length : 0;
    const stats: StageStats = {
      faces: count,
      projectedFaces: order.length,
      zeroAreaFaces,
      projections: projectionCount,
      angleLimit: Number(angleLimit.toFixed(3)),
      areaWeight: Number(areaWeight.toFixed(3)),
      projectionDotMin: Number((Number.isFinite(dotMin) ? dotMin : 0).toFixed(6)),
      projectionDotMean: Number(meanDot.toFixed(6)),
    };
    return { projections: Float32Array.from(projections), projectionCount, projectionOfFace, triangleUvs, stats, issues };
  }

  return {
    projections: new Float32Array(0),
    projectionCount: 0,
    projectionOfFace,
    triangleUvs,
    stats: {
      faces: count,
      projectedFaces: order.length,
      zeroAreaFaces,
      projections: 0,
      angleLimit: Number(angleLimit.toFixed(3)),
      areaWeight: Number(areaWeight.toFixed(3)),
      projectionDotMin: 0,
      projectionDotMean: 0,
    },
    issues,
  };
}

function bboxOf(uvs: Float32Array): ChartUv['bbox'] {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let index = 0; index < uvs.length; index += 2) {
    minU = Math.min(minU, uvs[index]);
    minV = Math.min(minV, uvs[index + 1]);
    maxU = Math.max(maxU, uvs[index]);
    maxV = Math.max(maxV, uvs[index + 1]);
  }
  if (!Number.isFinite(minU)) return { minU: 0, minV: 0, maxU: 0, maxV: 0 };
  return { minU, minV, maxU, maxV };
}

function normalSum(faces: ArrayLike<number>, face: FaceGeometry): [number, number, number] {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let index = 0; index < faces.length; index += 1) {
    const triangle = faces[index];
    sx += face.normals[triangle * 3] * face.areas[triangle];
    sy += face.normals[triangle * 3 + 1] * face.areas[triangle];
    sz += face.normals[triangle * 3 + 2] * face.areas[triangle];
  }
  return [sx, sy, sz];
}

function averageNormal(faces: ArrayLike<number>, face: FaceGeometry): number[] {
  const [sx, sy, sz] = normalSum(faces, face);
  const length = Math.hypot(sx, sy, sz);
  return length > 0 ? [sx / length, sy / length, sz / length] : [0, 0, 1];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export type DensityRefineResult = {
  charts: ChartUv[];
  rounds: number;
  splits: number;
  unresolved: number;
  spreadBefore: number;
  spreadAfter: number;
  timedOut: boolean;
};

export type MinimizeLayoutResult = {
  layout: ChartLayout;
  merges: number;
  timedOut: boolean;
  boundaryEdges: number;
};

export type MinimizeResult = MinimizeLayoutResult & {
  charts: ChartUv[];
};

export function buildChartFromFaces(
  mesh: ConditionedMesh,
  face: FaceGeometry,
  chartId: number,
  triangles: number[],
  axis: number[],
): ChartUv {
  const basis = orthoBasis(axis, 0);
  const localOf = new Map<number, number>();
  const localVertex: number[] = [];
  const uvs: number[] = [];
  const localIndices: number[] = [];
  let worldArea = 0;
  let uvArea = 0;
  for (const triangle of triangles) {
    worldArea += face.areas[triangle];
    const corners: number[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = mesh.indices[triangle * 3 + corner];
      let local = localOf.get(vertex);
      if (local === undefined) {
        local = localVertex.length;
        localOf.set(vertex, local);
        localVertex.push(vertex);
        const x = mesh.positions[vertex * 3];
        const y = mesh.positions[vertex * 3 + 1];
        const z = mesh.positions[vertex * 3 + 2];
        uvs.push(
          x * basis[0] + y * basis[1] + z * basis[2],
          x * basis[3] + y * basis[4] + z * basis[5],
        );
      }
      corners.push(local);
    }
    localIndices.push(corners[0], corners[1], corners[2]);
    const a = corners[0] * 2;
    const b = corners[1] * 2;
    const c = corners[2] * 2;
    uvArea += Math.abs(signedTriangleArea2D(
      uvs[a], uvs[a + 1],
      uvs[b], uvs[b + 1],
      uvs[c], uvs[c + 1],
    ));
  }
  return {
    chart: chartId,
    triangles: Uint32Array.from(triangles),
    localIndices: Uint32Array.from(localIndices),
    localVertex: Uint32Array.from(localVertex),
    uvs: Float32Array.from(uvs),
    worldArea,
    uvArea,
    bbox: bboxOf(Float32Array.from(uvs)),
    solverIterations: 0,
    solverResidual: 0,
    solverConverged: true,
    initialization: 'projection',
    failed: false,
    failure: null,
  };
}

export function chartDensitySpread(chart: ChartUv, face: FaceGeometry): number {
  const densities = chartFaceDensities(chart, face, 1);
  let min = Infinity;
  let max = 0;
  for (const density of densities) {
    if (!(density > 0)) continue;
    if (density < min) min = density;
    if (density > max) max = density;
  }
  if (!Number.isFinite(min) || max <= 0) return 0;
  return max / min - 1;
}

export function chartSetDensitySpread(charts: ChartUv[], face: FaceGeometry): number {
  let min = Infinity;
  let max = 0;
  for (const chart of charts) {
    for (const density of chartFaceDensities(chart, face, 1)) {
      if (!(density > 0)) continue;
      if (density < min) min = density;
      if (density > max) max = density;
    }
  }
  if (!Number.isFinite(min) || max <= 0) return 0;
  return max / min - 1;
}

export function chartSetBBoxArea(charts: ChartUv[]): number {
  let total = 0;
  for (const chart of charts) {
    total += (chart.bbox.maxU - chart.bbox.minU) * (chart.bbox.maxV - chart.bbox.minV);
  }
  return total;
}

export function compactChartLayout(charts: ChartUv[], face: FaceGeometry): ChartLayout {
  const offsets = new Uint32Array(charts.length + 1);
  let faceCount = 0;
  for (let chart = 0; chart < charts.length; chart += 1) {
    offsets[chart] = faceCount;
    faceCount += charts[chart].triangles.length;
  }
  offsets[charts.length] = faceCount;
  const faces = new Uint32Array(faceCount);
  const axes = new Float32Array(charts.length * 3);
  let offset = 0;
  for (let chart = 0; chart < charts.length; chart += 1) {
    const current = charts[chart];
    faces.set(current.triangles, offset);
    offset += current.triangles.length;
    const sum = normalSum(current.triangles, face);
    const length = Math.hypot(sum[0], sum[1], sum[2]);
    if (length > 0) {
      axes[chart * 3] = sum[0] / length;
      axes[chart * 3 + 1] = sum[1] / length;
      axes[chart * 3 + 2] = sum[2] / length;
    } else {
      axes[chart * 3 + 2] = 1;
    }
  }
  return { offsets, faces, axes, chartCount: charts.length };
}

/** Total projected bounding-box area of a compact layout. This is a cheap
 * packability proxy used to break ties before the final atlas packing run. */
export function chartLayoutBBoxArea(
  mesh: ConditionedMesh,
  layout: ChartLayout,
): number {
  let total = 0;
  for (let chart = 0; chart < layout.chartCount; chart += 1) {
    const basis = orthoBasis(layout.axes, chart * 3);
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (let offset = layout.offsets[chart]; offset < layout.offsets[chart + 1]; offset += 1) {
      const triangle = layout.faces[offset];
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = mesh.indices[triangle * 3 + corner];
        const x = mesh.positions[vertex * 3];
        const y = mesh.positions[vertex * 3 + 1];
        const z = mesh.positions[vertex * 3 + 2];
        const u = x * basis[0] + y * basis[1] + z * basis[2];
        const v = x * basis[3] + y * basis[4] + z * basis[5];
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
    if (Number.isFinite(minU)) total += (maxU - minU) * (maxV - minV);
  }
  return total;
}

export function materializeChartLayout(
  mesh: ConditionedMesh,
  face: FaceGeometry,
  layout: ChartLayout,
): ChartUv[] {
  const charts: ChartUv[] = [];
  for (let chart = 0; chart < layout.chartCount; chart += 1) {
    const start = layout.offsets[chart];
    const end = layout.offsets[chart + 1];
    const faces = Array.from(layout.faces.subarray(start, end));
    charts.push(buildChartFromFaces(mesh, face, chart, faces, [
      layout.axes[chart * 3],
      layout.axes[chart * 3 + 1],
      layout.axes[chart * 3 + 2],
    ]));
  }
  return charts;
}

/** Counts charts whose projected face densities vary beyond the tolerance.
 * Works from the compact layout, so task results do not need ChartUv objects. */
export function layoutDensityUnresolved(
  mesh: ConditionedMesh,
  face: FaceGeometry,
  layout: ChartLayout,
  tolerance: number,
): number {
  const limit = (1 + tolerance) * (1 + tolerance) + 1e-12;
  let unresolved = 0;
  for (let chart = 0; chart < layout.chartCount; chart += 1) {
    const basis = orthoBasis([
      layout.axes[chart * 3],
      layout.axes[chart * 3 + 1],
      layout.axes[chart * 3 + 2],
    ], 0);
    const start = layout.offsets[chart];
    const end = layout.offsets[chart + 1];
    let minRatio = Infinity;
    let maxRatio = 0;
    for (let index = start; index < end; index += 1) {
      const triangle = layout.faces[index];
      const world = face.areas[triangle];
      if (!(world > 1e-12)) continue;
      const a = mesh.indices[triangle * 3] * 3;
      const b = mesh.indices[triangle * 3 + 1] * 3;
      const c = mesh.indices[triangle * 3 + 2] * 3;
      const area = Math.abs(signedTriangleArea2D(
        mesh.positions[a] * basis[0] + mesh.positions[a + 1] * basis[1] + mesh.positions[a + 2] * basis[2],
        mesh.positions[a] * basis[3] + mesh.positions[a + 1] * basis[4] + mesh.positions[a + 2] * basis[5],
        mesh.positions[b] * basis[0] + mesh.positions[b + 1] * basis[1] + mesh.positions[b + 2] * basis[2],
        mesh.positions[b] * basis[3] + mesh.positions[b + 1] * basis[4] + mesh.positions[b + 2] * basis[5],
        mesh.positions[c] * basis[0] + mesh.positions[c + 1] * basis[1] + mesh.positions[c + 2] * basis[2],
        mesh.positions[c] * basis[3] + mesh.positions[c + 1] * basis[4] + mesh.positions[c + 2] * basis[5],
      ));
      if (!(area > 1e-12)) continue;
      const ratio = area / world;
      if (ratio < minRatio) minRatio = ratio;
      if (ratio > maxRatio) maxRatio = ratio;
      if (maxRatio / minRatio > limit) {
        unresolved += 1;
        break;
      }
    }
  }
  return unresolved;
}

function connectedChartParts(
  chart: ChartUv,
  neighbors: number[][],
  selected: Set<number>,
): number[][] {
  const seen = new Set<number>();
  const parts: number[][] = [];
  for (const start of chart.triangles) {
    if (seen.has(start) || !selected.has(start)) continue;
    const part: number[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const triangle = queue.pop()!;
      part.push(triangle);
      for (const neighbor of neighbors[triangle]) {
        if (seen.has(neighbor) || !selected.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
    parts.push(part.sort((a, b) => a - b));
  }
  return parts;
}

function splitChartBySymmetry(
  chart: ChartUv,
  mesh: ConditionedMesh,
  face: FaceGeometry,
  neighbors: number[][],
  plane: MirrorPlane,
): { faces: number[]; axis: number[] }[] | null {
  const positive = new Set<number>();
  const negative = new Set<number>();
  for (const triangle of chart.triangles) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = mesh.indices[triangle * 3 + corner];
      cx += mesh.positions[vertex * 3];
      cy += mesh.positions[vertex * 3 + 1];
      cz += mesh.positions[vertex * 3 + 2];
    }
    const side = (cx / 3) * plane.normal[0]
      + (cy / 3) * plane.normal[1]
      + (cz / 3) * plane.normal[2]
      - plane.offset;
    if (side >= 0) positive.add(triangle);
    else negative.add(triangle);
  }
  if (positive.size === 0 || negative.size === 0) return null;
  const parts = [
    ...connectedChartParts(chart, neighbors, positive),
    ...connectedChartParts(chart, neighbors, negative),
  ].sort((a, b) => a[0] - b[0]);
  if (parts.length <= 1) return null;
  return parts.map((faces) => ({ faces, axis: averageNormal(faces, face) }));
}

function splitChartByDensity(
  chart: ChartUv,
  face: FaceGeometry,
  neighbors: number[][],
  tolerance: number,
  strategy: number,
  mesh?: ConditionedMesh,
  plane?: MirrorPlane | null,
): { faces: number[]; axis: number[] }[] | null {
  if (strategy % 6 === 5) {
    if (!mesh || !plane) return null;
    return splitChartBySymmetry(chart, mesh, face, neighbors, plane);
  }
  const densities = chartFaceDensities(chart, face, 1);
  const positive = densities.filter((density) => density > 0).sort((a, b) => a - b);
  if (positive.length < 2) return null;
  const maxDensity = positive[positive.length - 1];
  const minDensity = positive[0];
  if (maxDensity / minDensity - 1 <= tolerance) return null;
  let cutoff: number;
  let lowIsBelow: boolean;
  switch (strategy % 6) {
    case 1:
      cutoff = minDensity * (1 + tolerance);
      lowIsBelow = false;
      break;
    case 2:
      cutoff = positive[Math.floor(positive.length / 2)];
      lowIsBelow = true;
      break;
    case 3: {
      let sum = 0;
      for (const density of positive) sum += density;
      cutoff = sum / positive.length;
      lowIsBelow = true;
      break;
    }
    case 4:
      cutoff = maxDensity / (1 + tolerance * 0.6);
      lowIsBelow = true;
      break;
    default:
      cutoff = maxDensity / (1 + tolerance);
      lowIsBelow = true;
  }
  const low = new Set<number>();
  for (let index = 0; index < chart.triangles.length; index += 1) {
    const density = densities[index];
    if (density <= 0) continue;
    if (lowIsBelow ? density < cutoff : density > cutoff) low.add(chart.triangles[index]);
  }
  if (low.size === 0 || low.size === chart.triangles.length) return null;

  const high = new Set<number>();
  for (const triangle of chart.triangles) {
    if (!low.has(triangle)) high.add(triangle);
  }
  const parts = [
    ...connectedChartParts(chart, neighbors, low),
    ...connectedChartParts(chart, neighbors, high),
  ].sort((a, b) => a[0] - b[0]);
  if (parts.length <= 1) return null;
  return parts.map((faces) => ({ faces, axis: averageNormal(faces, face) }));
}

export function refineChartsByDensity(
  charts: ChartUv[],
  mesh: ConditionedMesh,
  face: FaceGeometry,
  neighbors: number[][],
  tolerance: number,
  strategy: number,
  deadline: number,
  plane?: MirrorPlane | null,
): DensityRefineResult {
  const spreadBefore = chartSetDensitySpread(charts, face);
  const maxRounds = 8;
  const maxCharts = Math.max(512, charts.length * 4);
  let current = charts;
  let rounds = 0;
  let splits = 0;
  let timedOut = false;
  for (; rounds < maxRounds; rounds += 1) {
    if (nowEpoch() >= deadline) {
      timedOut = true;
      break;
    }
    const next: ChartUv[] = [];
    let changed = false;
    let capped = false;
    for (const chart of current) {
      if (nowEpoch() >= deadline) {
        timedOut = true;
        break;
      }
      const parts = splitChartByDensity(
        chart,
        face,
        neighbors,
        tolerance,
        strategy,
        mesh,
        plane,
      );
      if (!parts) {
        next.push(chart);
        continue;
      }
      changed = true;
      splits += parts.length - 1;
      for (const part of parts) {
        next.push(buildChartFromFaces(mesh, face, next.length, part.faces, part.axis));
      }
      if (next.length > maxCharts) {
        capped = true;
        break;
      }
    }
    if (!changed) break;
    if (capped) break;
    if (timedOut) break;
    current = next;
  }
  const refined = current.map((chart, index) => ({ ...chart, chart: index }));
  let unresolved = 0;
  for (const chart of refined) {
    if (chartDensitySpread(chart, face) > tolerance) unresolved += 1;
  }
  return {
    charts: refined,
    rounds,
    splits,
    unresolved,
    spreadBefore,
    spreadAfter: chartSetDensitySpread(refined, face),
    timedOut,
  };
}

/** Checks a merged projection without building the full chart. Candidate
 * merges outnumber accepted merges many times over, so this avoids the vertex
 * deduplication, bbox, and typed-array allocation of buildChartFromFaces. */
function mergedProjectionFits(
  mesh: ConditionedMesh,
  face: FaceGeometry,
  first: ArrayLike<number>,
  second: ArrayLike<number>,
  axis: number[],
  tolerance: number,
): boolean {
  const basis = orthoBasis(axis, 0);
  const ux = basis[0];
  const uy = basis[1];
  const uz = basis[2];
  const vx = basis[3];
  const vy = basis[4];
  const vz = basis[5];
  let minRatio = Infinity;
  let maxRatio = 0;
  const limit = (1 + tolerance) * (1 + tolerance);
  for (const faces of [first, second]) {
    for (let index = 0; index < faces.length; index += 1) {
      const triangle = faces[index];
      const world = face.areas[triangle];
      if (!(world > 1e-12)) continue;
      const a = mesh.indices[triangle * 3];
      const b = mesh.indices[triangle * 3 + 1];
      const c = mesh.indices[triangle * 3 + 2];
      const ax = mesh.positions[a * 3];
      const ay = mesh.positions[a * 3 + 1];
      const az = mesh.positions[a * 3 + 2];
      const bx = mesh.positions[b * 3];
      const by = mesh.positions[b * 3 + 1];
      const bz = mesh.positions[b * 3 + 2];
      const cx = mesh.positions[c * 3];
      const cy = mesh.positions[c * 3 + 1];
      const cz = mesh.positions[c * 3 + 2];
      const area = Math.abs(signedTriangleArea2D(
        ax * ux + ay * uy + az * uz,
        ax * vx + ay * vy + az * vz,
        bx * ux + by * uy + bz * uz,
        bx * vx + by * vy + bz * vz,
        cx * ux + cy * uy + cz * uz,
        cx * vx + cy * vy + cz * vz,
      ));
      if (!(area > 1e-12)) return false;
      const ratio = area / world;
      if (ratio < minRatio) minRatio = ratio;
      if (ratio > maxRatio) maxRatio = ratio;
      if (maxRatio / minRatio > limit + 1e-12) return false;
    }
  }
  return true;
}

export function minimizeChartLayout(
  charts: ChartUv[],
  mesh: ConditionedMesh,
  face: FaceGeometry,
  topology: MeshTopology,
  seamEdge: Uint8Array,
  tolerance: number,
  deadline: number,
  mergeCos: number,
  axisMergeCos: number,
  seed: number,
): MinimizeLayoutResult {
  let current: number[][] = charts.map((chart) => Array.from(chart.triangles));
  let sums = charts.map((chart) => normalSum(chart.triangles, face));
  let merges = 0;
  let timedOut = false;
  while (current.length > 1) {
    if (nowEpoch() >= deadline) {
      timedOut = true;
      break;
    }
    const chartOf = new Int32Array(mesh.triangleCount).fill(-1);
    for (let chartId = 0; chartId < current.length; chartId += 1) {
      for (const triangle of current[chartId]) chartOf[triangle] = chartId;
    }
    const borders = new Map<number, { a: number; b: number; count: number }>();
    for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
      const edge = topology.edges[edgeIndex];
      if (edge.triangles.length !== 2 || seamEdge[edgeIndex]) continue;
      const chartA = chartOf[edge.triangles[0]];
      const chartB = chartOf[edge.triangles[1]];
      if (chartA < 0 || chartB < 0 || chartA === chartB) continue;
      const low = Math.min(chartA, chartB);
      const high = Math.max(chartA, chartB);
      const key = low * current.length + high;
      const entry = borders.get(key) ?? { a: low, b: high, count: 0 };
      entry.count += 1;
      borders.set(key, entry);
    }
    const random = mulberry32(seed);
    const candidates = [...borders.values()]
      .map((entry) => ({ ...entry, score: entry.count * (seed === 0 ? 1 : 0.5 + random()) }))
      .sort((x, y) => y.score - x.score);
    // Apply every non-conflicting merge found in this border pass. One
    // rebuild then serves many merges instead of one merge per rebuild.
    const used = new Uint8Array(current.length);
    const plans: Array<{
      a: number;
      b: number;
      faces: number[];
      sum: [number, number, number];
    }> = [];
    for (const candidate of candidates) {
      if (nowEpoch() >= deadline) {
        timedOut = true;
        break;
      }
      if (used[candidate.a] || used[candidate.b]) continue;
      const first = current[candidate.a];
      const second = current[candidate.b];
      if (!first || !second) continue;
      const firstSum = sums[candidate.a];
      const secondSum = sums[candidate.b];
      const firstLength = Math.hypot(firstSum[0], firstSum[1], firstSum[2]);
      const secondLength = Math.hypot(secondSum[0], secondSum[1], secondSum[2]);
      if (firstLength === 0 || secondLength === 0) continue;
      const axisDot = (firstSum[0] * secondSum[0]
        + firstSum[1] * secondSum[1]
        + firstSum[2] * secondSum[2]) / (firstLength * secondLength);
      if (axisDot < axisMergeCos) continue;
      const sum: [number, number, number] = [
        firstSum[0] + secondSum[0],
        firstSum[1] + secondSum[1],
        firstSum[2] + secondSum[2],
      ];
      const length = Math.hypot(sum[0], sum[1], sum[2]);
      if (length === 0) continue;
      const axis = [sum[0] / length, sum[1] / length, sum[2] / length];
      let fits = true;
      for (const chart of [first, second]) {
        for (const triangle of chart) {
          const dot = face.normals[triangle * 3] * axis[0]
            + face.normals[triangle * 3 + 1] * axis[1]
            + face.normals[triangle * 3 + 2] * axis[2];
          if (dot < mergeCos - 1e-9) {
            fits = false;
            break;
          }
        }
        if (!fits) break;
      }
      if (!fits) continue;
      if (!mergedProjectionFits(mesh, face, first, second, axis, tolerance)) {
        continue;
      }
      used[candidate.a] = 1;
      used[candidate.b] = 1;
      plans.push({
        a: candidate.a,
        b: candidate.b,
        faces: [...first, ...second],
        sum,
      });
    }
    if (plans.length === 0) break;
    const planByFirst = new Map<number, (typeof plans)[number]>();
    const removed = new Uint8Array(current.length);
    for (const plan of plans) {
      planByFirst.set(plan.a, plan);
      removed[plan.b] = 1;
    }
    const next: number[][] = [];
    const nextSums: Array<[number, number, number]> = [];
    for (let chartId = 0; chartId < current.length; chartId += 1) {
      if (removed[chartId]) continue;
      const plan = planByFirst.get(chartId);
      if (plan) {
        next.push(plan.faces);
        nextSums.push(plan.sum);
      } else {
        next.push(current[chartId]);
        nextSums.push(sums[chartId]);
      }
    }
    current = next;
    sums = nextSums;
    merges += plans.length;
    if (timedOut) break;
  }
  const chartOf = new Int32Array(mesh.triangleCount).fill(-1);
  for (let chartId = 0; chartId < current.length; chartId += 1) {
    for (const triangle of current[chartId]) chartOf[triangle] = chartId;
  }
  let boundaryEdges = 0;
  for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
    const edge = topology.edges[edgeIndex];
    if (edge.triangles.length !== 2 || seamEdge[edgeIndex]) continue;
    if (chartOf[edge.triangles[0]] !== chartOf[edge.triangles[1]]) boundaryEdges += 1;
  }
  const offsets = new Uint32Array(current.length + 1);
  let faceCount = 0;
  for (let chart = 0; chart < current.length; chart += 1) {
    offsets[chart] = faceCount;
    faceCount += current[chart].length;
  }
  offsets[current.length] = faceCount;
  const faces = new Uint32Array(faceCount);
  let faceOffset = 0;
  for (const chart of current) {
    faces.set(chart, faceOffset);
    faceOffset += chart.length;
  }
  const axes = new Float32Array(current.length * 3);
  for (let chart = 0; chart < current.length; chart += 1) {
    const sum = sums[chart];
    const length = Math.hypot(sum[0], sum[1], sum[2]);
    if (length > 0) {
      axes[chart * 3] = sum[0] / length;
      axes[chart * 3 + 1] = sum[1] / length;
      axes[chart * 3 + 2] = sum[2] / length;
    } else {
      axes[chart * 3 + 2] = 1;
    }
  }
  return {
    layout: { offsets, faces, axes, chartCount: current.length },
    merges,
    timedOut,
    boundaryEdges,
  };
}

export function minimizeCharts(
  charts: ChartUv[],
  mesh: ConditionedMesh,
  face: FaceGeometry,
  topology: MeshTopology,
  seamEdge: Uint8Array,
  tolerance: number,
  deadline: number,
  mergeCos: number,
  axisMergeCos: number,
  seed: number,
): MinimizeResult {
  const result = minimizeChartLayout(
    charts,
    mesh,
    face,
    topology,
    seamEdge,
    tolerance,
    deadline,
    mergeCos,
    axisMergeCos,
    seed,
  );
  return {
    ...result,
    charts: materializeChartLayout(mesh, face, result.layout),
  };
}

export type SmartIslandBase = {
  seams: SeamResult;
  neighbors: number[][];
  baseCharts: ChartUv[];
  seamSplits: number;
  islandSplits: number;
  symmetrySeams: number;
  mirrorPlane: MirrorPlane | null;
  tolerance: number;
  mergeCos: number;
  axisMergeCos: number;
  growthScale: number;
};

export type SmartIslandVariant = {
  id: string;
  label: string;
  base: SmartIslandBase;
  /** Number of cut strategies this variant supports. */
  cutStrategies: number;
};

export type SmartRefineOutcome = {
  layout: ChartLayout;
  islandMerges: number;
  refineRestarts: number;
  wasmTasks: number;
  cutAttempts: number;
  islandBoundaryEdges: number;
  densityRounds: number;
  densitySplits: number;
  densitySpreadBefore: number;
  densityUnresolved: number;
  refineTimedOut: boolean;
  refineStoppedEarly: boolean;
  refineTimeMs: number;
  budgetMs: number;
  strategyVariants: number;
  strategyAttempts: number;
  bestStrategy: number;
  variantId: string;
};

export type RefineRunnerInput = {
  mesh: ConditionedMesh;
  topology: MeshTopology;
  face: FaceGeometry;
  variants: SmartIslandVariant[];
  deadline: number;
  budgetMs: number;
};

export type RefineRunner = (input: RefineRunnerInput) => Promise<SmartRefineOutcome>;

/** Builds the uncut island layout and the adjacency used by every refinement
 * attempt. This part is deterministic and shared by threaded workers. */
export function buildSmartIslandBase(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  face: FaceGeometry,
  projection: SmartProjectionResult,
  options: SmartIslandOptions,
): SmartIslandBase {
  const seams = computeSeams(mesh, topology, face, {
    seamAngle: 180,
    splitByObject: options.splitByObject,
    splitByMaterial: options.splitByMaterial,
    useUvSeams: false,
  });
  let symmetrySeams = 0;
  let mirrorPlane: MirrorPlane | null = null;
  if (options.symmetry?.plane) {
    mirrorPlane = options.symmetry.plane;
    const seamCount = Math.min(seams.seamEdge.length, options.symmetry.seamEdge.length);
    for (let edgeIndex = 0; edgeIndex < seamCount; edgeIndex += 1) {
      if (!options.symmetry.seamEdge[edgeIndex] || seams.seamEdge[edgeIndex]) continue;
      seams.seamEdge[edgeIndex] = 1;
      symmetrySeams += 1;
      const edge = topology.edges[edgeIndex];
      seams.interiorSeamLength += Math.hypot(
        mesh.positions[edge.b * 3] - mesh.positions[edge.a * 3],
        mesh.positions[edge.b * 3 + 1] - mesh.positions[edge.a * 3 + 1],
        mesh.positions[edge.b * 3 + 2] - mesh.positions[edge.a * 3 + 2],
      );
    }
    seams.interiorSeamCount += symmetrySeams;
  }
  const count = mesh.triangleCount;
  const neighbors: number[][] = Array.from({ length: count }, () => []);
  for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
    const edge = topology.edges[edgeIndex];
    if (edge.triangles.length !== 2) continue;
    const [a, b] = edge.triangles;
    if (seams.seamEdge[edgeIndex]) continue;
    neighbors[a].push(b);
    neighbors[b].push(a);
  }

  const angleLimit = Math.max(0, Math.min(180, Number(projection.stats.angleLimit ?? 66)));
  const growthScale = Math.max(0.2, Math.min(1, options.growthScale ?? 0.5));
  // Growth limits faces to a fraction of the projection angle; merging only
  // combines islands with similar projectors so distortion stays bounded.
  const halfCos = Math.cos(angleLimit * growthScale * DEG_TO_RAD);
  const mergeScale = growthScale / 0.5;
  const mergeCos = Math.cos(Math.min(angleLimit, 50 * mergeScale) * DEG_TO_RAD);
  const axisMergeCos = Math.cos(Math.min(angleLimit, 45 * mergeScale) * DEG_TO_RAD);
  const assigned = new Int32Array(count).fill(-1);
  const islands: number[][] = [];
  const order: number[] = [];
  for (let triangle = 0; triangle < count; triangle += 1) {
    if (face.areas[triangle] > 0) order.push(triangle);
  }
  order.sort((a, b) => face.areas[b] - face.areas[a] || a - b);

  for (const seed of order) {
    if (assigned[seed] >= 0) continue;
    const island = islands.length;
    const ax = face.normals[seed * 3];
    const ay = face.normals[seed * 3 + 1];
    const az = face.normals[seed * 3 + 2];
    const members: number[] = [];
    const queue = [seed];
    assigned[seed] = island;
    while (queue.length > 0) {
      const triangle = queue.pop()!;
      members.push(triangle);
      for (const neighbor of neighbors[triangle]) {
        if (assigned[neighbor] >= 0) continue;
        const dot = face.normals[neighbor * 3] * ax
          + face.normals[neighbor * 3 + 1] * ay
          + face.normals[neighbor * 3 + 2] * az;
        if (dot < halfCos) continue;
        assigned[neighbor] = island;
        queue.push(neighbor);
      }
    }
    islands.push(members.sort((a, b) => a - b));
  }
  for (let triangle = 0; triangle < count; triangle += 1) {
    if (assigned[triangle] >= 0) continue;
    assigned[triangle] = islands.length;
    islands.push([triangle]);
  }

  const islandSumX = new Float64Array(islands.length);
  const islandSumY = new Float64Array(islands.length);
  const islandSumZ = new Float64Array(islands.length);
  for (let island = 0; island < islands.length; island += 1) {
    for (const triangle of islands[island]) {
      islandSumX[island] += face.normals[triangle * 3] * face.areas[triangle];
      islandSumY[island] += face.normals[triangle * 3 + 1] * face.areas[triangle];
      islandSumZ[island] += face.normals[triangle * 3 + 2] * face.areas[triangle];
    }
  }
  const islandRoot = new Int32Array(islands.length);
  for (let island = 0; island < islands.length; island += 1) islandRoot[island] = island;
  const findIsland = (value: number): number => {
    let root = value;
    while (islandRoot[root] !== root) root = islandRoot[root];
    while (islandRoot[value] !== root) {
      const next = islandRoot[value];
      islandRoot[value] = root;
      value = next;
    }
    return root;
  };

  let remaining = islands.length;
  for (let round = 0; round < 512 && remaining > 1; round += 1) {
    const borders = new Map<string, { a: number; b: number; count: number }>();
    for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
      const edge = topology.edges[edgeIndex];
      if (edge.triangles.length !== 2 || seams.seamEdge[edgeIndex]) continue;
      const [a, b] = edge.triangles;
      const rootA = findIsland(assigned[a]);
      const rootB = findIsland(assigned[b]);
      if (rootA === rootB) continue;
      const low = Math.min(rootA, rootB);
      const high = Math.max(rootA, rootB);
      const key = `${low}:${high}`;
      const entry = borders.get(key) ?? { a: low, b: high, count: 0 };
      entry.count += 1;
      borders.set(key, entry);
    }
    const candidates = [...borders.values()].sort((x, y) => y.count - x.count);
    let mergedAny = false;
    for (const candidate of candidates) {
      const rootA = findIsland(candidate.a);
      const rootB = findIsland(candidate.b);
      if (rootA === rootB) continue;
      const lengthA = Math.hypot(islandSumX[rootA], islandSumY[rootA], islandSumZ[rootA]);
      const lengthB = Math.hypot(islandSumX[rootB], islandSumY[rootB], islandSumZ[rootB]);
      if (lengthA === 0 || lengthB === 0) continue;
      const axisDot = (islandSumX[rootA] * islandSumX[rootB]
        + islandSumY[rootA] * islandSumY[rootB]
        + islandSumZ[rootA] * islandSumZ[rootB]) / (lengthA * lengthB);
      if (axisDot < axisMergeCos) continue;
      const sx = islandSumX[rootA] + islandSumX[rootB];
      const sy = islandSumY[rootA] + islandSumY[rootB];
      const sz = islandSumZ[rootA] + islandSumZ[rootB];
      const length = Math.hypot(sx, sy, sz);
      if (length === 0) continue;
      const ax = sx / length;
      const ay = sy / length;
      const az = sz / length;
      let fits = true;
      for (const root of [rootA, rootB]) {
        for (const triangle of islands[root]) {
          const dot = face.normals[triangle * 3] * ax
            + face.normals[triangle * 3 + 1] * ay
            + face.normals[triangle * 3 + 2] * az;
          if (dot < mergeCos - 1e-9) {
            fits = false;
            break;
          }
        }
        if (!fits) break;
      }
      if (!fits) continue;
      islandRoot[rootB] = rootA;
      islandSumX[rootA] = sx;
      islandSumY[rootA] = sy;
      islandSumZ[rootA] = sz;
      islands[rootA] = islands[rootA].concat(islands[rootB]);
      islands[rootB] = [];
      remaining -= 1;
      mergedAny = true;
      break;
    }
    if (!mergedAny) break;
  }

  const finalIslands: number[][] = [];
  const finalAxes: number[][] = [];
  const finalOfFace = new Int32Array(count).fill(-1);
  for (let island = 0; island < islands.length; island += 1) {
    if (islands[island].length === 0 || findIsland(island) !== island) continue;
    const members = islands[island].sort((a, b) => a - b);
    const length = Math.hypot(islandSumX[island], islandSumY[island], islandSumZ[island]);
    const axis = length > 0
      ? [islandSumX[island] / length, islandSumY[island] / length, islandSumZ[island] / length]
      : [0, 0, 1];
    const chart = finalIslands.length;
    for (const triangle of members) finalOfFace[triangle] = chart;
    finalIslands.push(members);
    finalAxes.push(axis);
  }

  let seamSplits = 0;
  let islandSplits = 0;
  for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
    const edge = topology.edges[edgeIndex];
    if (edge.triangles.length !== 2) continue;
    const [a, b] = edge.triangles;
    if (seams.seamEdge[edgeIndex]) {
      if (projection.projectionOfFace[a] === projection.projectionOfFace[b]) seamSplits += 1;
      continue;
    }
    if (finalOfFace[a] !== finalOfFace[b]) islandSplits += 1;
  }

  // Keep a small margin so floating-point density ratios stay below the
  // validation threshold after atlas scaling.
  const tolerance = Math.max(0.02, (options.maxDensitySpread ?? 0.1) - DENSITY_SPREAD_MARGIN);
  const baseCharts = finalIslands.map((triangles, index) =>
    buildChartFromFaces(mesh, face, index, triangles, finalAxes[index]));
  return {
    seams,
    neighbors,
    baseCharts,
    seamSplits,
    islandSplits,
    symmetrySeams,
    mirrorPlane,
    tolerance,
    mergeCos,
    axisMergeCos,
    growthScale,
  };
}

function outcomeIsBetter(candidate: SmartRefineOutcome, best: SmartRefineOutcome): boolean {
  if (candidate.densityUnresolved !== best.densityUnresolved) {
    return candidate.densityUnresolved < best.densityUnresolved;
  }
  if (candidate.layout.chartCount !== best.layout.chartCount) {
    return candidate.layout.chartCount < best.layout.chartCount;
  }
  return candidate.islandBoundaryEdges > best.islandBoundaryEdges;
}

/** Runs the refinement search for one island base inside one thread. */
function refineOneBase(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  face: FaceGeometry,
  base: SmartIslandBase,
  deadline: number,
  budgetMs: number,
): SmartRefineOutcome {
  const { seams, neighbors, baseCharts, tolerance, mergeCos, axisMergeCos, mirrorPlane } = base;
  const refineStarted = performance.now();
  const refined = refineChartsByDensity(
    baseCharts,
    mesh,
    face,
    neighbors,
    tolerance,
    0,
    deadline,
    mirrorPlane,
  );
  let bestLayout = compactChartLayout(refined.charts, face);
  let bestChartCount = bestLayout.chartCount;
  let bestMerges = 0;
  let bestBoundaryEdges = Infinity;
  let bestUnresolved = refined.unresolved;
  let working = refined.charts;
  let strategyIndex = 0;
  let cutAttempts = 1;
  let refineRestarts = 0;
  let minimizeTimedOut = false;
  let staleRestarts = 0;
  if (!refined.timedOut) {
    while (nowEpoch() < deadline) {
      const seed = refineRestarts === 0 ? 0 : refineRestarts * 7919 + 1;
      const result = minimizeChartLayout(
        working,
        mesh,
        face,
        topology,
        seams.seamEdge,
        tolerance,
        deadline,
        mergeCos,
        axisMergeCos,
        seed,
      );
      refineRestarts += 1;
      const unresolved = layoutDensityUnresolved(mesh, face, result.layout, tolerance);
      const chartCount = result.layout.chartCount;
      const improves = bestUnresolved > 0
        || chartCount < bestChartCount
        || (chartCount === bestChartCount && result.boundaryEdges > bestBoundaryEdges);
      if (unresolved === 0 && improves) {
        bestLayout = result.layout;
        bestChartCount = chartCount;
        bestMerges = result.merges;
        bestBoundaryEdges = result.boundaryEdges;
        bestUnresolved = 0;
        staleRestarts = 0;
      } else {
        staleRestarts += 1;
      }
      if (result.timedOut) {
        minimizeTimedOut = true;
        break;
      }
      if (result.merges === 0 || bestChartCount <= 1) break;
      const lastStrategy = mirrorPlane ? 5 : 4;
      if (staleRestarts >= 4 && strategyIndex < lastStrategy) {
        let switched = false;
        while (strategyIndex < lastStrategy) {
          strategyIndex += 1;
          cutAttempts += 1;
          const alt = refineChartsByDensity(
            baseCharts,
            mesh,
            face,
            neighbors,
            tolerance,
            strategyIndex,
            deadline,
            mirrorPlane,
          );
          if (alt.timedOut) {
            minimizeTimedOut = true;
            break;
          }
          if (alt.unresolved > 0) continue;
          working = alt.charts;
          staleRestarts = 0;
          switched = true;
          break;
        }
        if (!switched) break;
        continue;
      }
      if (staleRestarts >= 12) break;
    }
  }
  const unresolvedCharts = layoutDensityUnresolved(mesh, face, bestLayout, tolerance);
  return {
    layout: bestLayout,
    islandMerges: bestMerges,
    refineRestarts,
    wasmTasks: 0,
    cutAttempts,
    islandBoundaryEdges: Number.isFinite(bestBoundaryEdges) ? bestBoundaryEdges : 0,
    densityRounds: refined.rounds,
    densitySplits: refined.splits,
    densitySpreadBefore: refined.spreadBefore,
    densityUnresolved: unresolvedCharts,
    refineTimedOut: refined.timedOut || minimizeTimedOut,
    refineStoppedEarly: false,
    refineTimeMs: performance.now() - refineStarted,
    budgetMs,
    strategyVariants: 1,
    strategyAttempts: 1,
    bestStrategy: 0,
    variantId: '',
  };
}

/** Tries every variant inside one thread, splitting the budget across them. */
export function refineSmartIslandsSequential(input: RefineRunnerInput): SmartRefineOutcome {
  const started = performance.now();
  const { mesh, topology, face, variants, deadline, budgetMs } = input;
  let best: SmartRefineOutcome | null = null;
  let bestStrategy = 0;
  let attempted = 0;
  let restarts = 0;
  let cuts = 0;
  const slice = variants.length > 0 ? Math.max(1, budgetMs / variants.length) : budgetMs;
  for (let index = 0; index < variants.length; index += 1) {
    if (nowEpoch() >= deadline) break;
    const variant = variants[index];
    attempted += 1;
    const variantDeadline = Math.min(deadline, nowEpoch() + slice);
    const outcome = refineOneBase(
      mesh,
      topology,
      face,
      variant.base,
      variantDeadline,
      budgetMs,
    );
    restarts += outcome.refineRestarts;
    cuts += outcome.cutAttempts;
    if (!best || outcomeIsBetter(outcome, best)) {
      best = outcome;
      bestStrategy = index;
    }
  }
  if (!best) {
    const fallbackBase = variants[0]?.base;
    const fallbackCharts = fallbackBase?.baseCharts ?? [];
    best = {
      layout: compactChartLayout(fallbackCharts, face),
      islandMerges: 0,
      refineRestarts: 0,
      wasmTasks: 0,
      cutAttempts: 0,
      islandBoundaryEdges: 0,
      densityRounds: 0,
      densitySplits: 0,
      densitySpreadBefore: chartSetDensitySpread(fallbackCharts, face),
      densityUnresolved: layoutDensityUnresolved(
        mesh,
        face,
        compactChartLayout(fallbackCharts, face),
        fallbackBase?.tolerance ?? 0.1,
      ),
      refineTimedOut: true,
      refineStoppedEarly: false,
      refineTimeMs: performance.now() - started,
      budgetMs,
      strategyVariants: variants.length,
      strategyAttempts: 0,
      bestStrategy: 0,
      variantId: variants[0]?.id ?? '',
    };
  }
  return {
    ...best,
    refineRestarts: restarts,
    cutAttempts: cuts,
    refineTimedOut: nowEpoch() >= deadline - 1,
    refineStoppedEarly: false,
    refineTimeMs: performance.now() - started,
    strategyVariants: variants.length,
    strategyAttempts: attempted,
    bestStrategy,
    variantId: variants[bestStrategy]?.id ?? '',
  };
}

function buildSmartVariants(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  face: FaceGeometry,
  projection: SmartProjectionResult,
  options: SmartIslandOptions,
): { variants: SmartIslandVariant[]; symmetry: SymmetryResult | null } {
  const symmetry = options.symmetry === undefined
    ? detectSymmetry(mesh, topology)
    : options.symmetry;
  const scales = mesh.triangleCount <= SMART_PORTFOLIO_FACE_LIMIT
    ? SMART_GROWTH_SCALES
    : SMART_GROWTH_SCALES_LARGE;
  const variants: SmartIslandVariant[] = [];
  for (const growthScale of scales) {
    const base = buildSmartIslandBase(mesh, topology, face, projection, {
      ...options,
      growthScale,
      symmetry: null,
    });
    variants.push({
      id: `growth-${growthScale.toFixed(2)}`,
      label: growthScale < 0.5 ? 'tight cuts' : growthScale > 0.5 ? 'wide islands' : 'balanced',
      base,
      cutStrategies: 5,
    });
  }
  if (symmetry?.plane) {
    const base = buildSmartIslandBase(mesh, topology, face, projection, {
      ...options,
      growthScale: 0.5,
      symmetry,
    });
    variants.push({
      id: 'mirror',
      label: 'mirror seams',
      base,
      cutStrategies: 6,
    });
  }
  return { variants, symmetry };
}

/** Groups projected faces into charts: one chart per connected component that
 * shares a projection axis and does not cross a seam. */
export async function buildSmartIslands(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  face: FaceGeometry,
  projection: SmartProjectionResult,
  options: SmartIslandOptions,
  runner?: RefineRunner,
): Promise<SmartIslandResult> {
  const { variants, symmetry } = buildSmartVariants(mesh, topology, face, projection, options);
  if (variants.length === 0) throw new Error('No smart island variants were built.');
  const count = mesh.triangleCount;
  const budgetMs = Math.max(0, options.budgetMs ?? 10_000);
  const deadline = nowEpoch() + budgetMs;
  const input: RefineRunnerInput = { mesh, topology, face, variants, deadline, budgetMs };
  let outcome: SmartRefineOutcome;
  if (runner) {
    try {
      outcome = await runner(input);
    } catch {
      outcome = refineSmartIslandsSequential(input);
    }
  } else {
    outcome = refineSmartIslandsSequential(input);
  }
  const chosenBase = variants.find((variant) => variant.id === outcome.variantId) ?? variants[0];
  const { seams, tolerance } = chosenBase.base;
  const charts = materializeChartLayout(mesh, face, outcome.layout);
  const chartOfTriangle = new Uint32Array(count);
  const triangleUvs = new Float32Array(count * 6);
  for (let chartId = 0; chartId < charts.length; chartId += 1) {
    const chart = charts[chartId];
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const triangle = chart.triangles[local];
      chartOfTriangle[triangle] = chartId;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = chart.localIndices[local * 3 + corner];
        triangleUvs[triangle * 6 + corner * 2] = chart.uvs[vertex * 2];
        triangleUvs[triangle * 6 + corner * 2 + 1] = chart.uvs[vertex * 2 + 1];
      }
    }
  }
  const uvAreaSum = charts.map((chart) => chart.uvArea);
  const islandSizes = charts.map((chart) => chart.triangles.length);

  let islandMin = 0;
  let islandMax = 0;
  for (const size of islandSizes) {
    if (islandMin === 0 || size < islandMin) islandMin = size;
    if (size > islandMax) islandMax = size;
  }
  const worldArea = charts.reduce((sum, chart) => sum + chart.worldArea, 0);
  const uvArea = uvAreaSum.reduce((sum, value) => sum + value, 0);
  const issues: Issue[] = [];
  if (seams.nonManifoldCount > 0) {
    issues.push({
      stage: 'islands',
      severity: 'warn',
      code: 'non-manifold-islands',
      message: `${seams.nonManifoldCount} non-manifold edge${seams.nonManifoldCount === 1 ? '' : 's'} split islands.`,
      value: seams.nonManifoldCount,
    });
  }
  if (projection.projectionCount === 0 && count > 0) {
    issues.push({
      stage: 'islands',
      severity: 'error',
      code: 'no-islands',
      message: 'No islands were built because there are no projection axes.',
    });
  }
  if (outcome.densityUnresolved > 0) {
    issues.push({
      stage: 'islands',
      severity: 'warn',
      code: 'density-unresolved',
      message: `${outcome.densityUnresolved} island${outcome.densityUnresolved === 1 ? '' : 's'} still vary above ${(tolerance * 100).toFixed(0)}% after ${outcome.densityRounds} density rounds.`,
      value: outcome.densityUnresolved,
      threshold: tolerance,
    });
  }
  if (outcome.refineTimedOut) {
    issues.push({
      stage: 'islands',
      severity: 'warn',
      code: 'refine-budget-exhausted',
      message: `Stopped island refinement at the ${(outcome.budgetMs / 1000).toFixed(0)} second budget.`,
    });
  }
  if (outcome.refineStoppedEarly) {
    issues.push({
      stage: 'islands',
      severity: 'info',
      code: 'refine-stagnated',
      message: `Stopped island refinement early after ${outcome.refineRestarts} tasks because no layout improved.`,
    });
  }

  const stats: StageStats = {
    charts: charts.length,
    faces: count,
    projections: projection.projectionCount,
    seamEdges: seams.interiorSeamCount,
    seamSplits: chosenBase.base.seamSplits,
    islandSplits: chosenBase.base.islandSplits,
    symmetrySeams: chosenBase.base.symmetrySeams,
    mirrorDetectedSeams: symmetry?.seamCount ?? 0,
    mirrorPlaneScore: symmetry?.plane?.score ?? 0,
    mirrorPlaneOffset: symmetry?.plane?.offset ?? 0,
    mirrorPlaneNormal: symmetry?.plane
      ? symmetry.plane.normal.map((value) => value.toFixed(3)).join(',')
      : '',
    growthScale: chosenBase.base.growthScale,
    strategyVariants: outcome.strategyVariants,
    strategyAttempts: outcome.strategyAttempts,
    bestStrategy: outcome.bestStrategy,
    bestVariant: outcome.variantId,
    bestVariantLabel: chosenBase.label,
    objectSeams: seams.objectSeamCount,
    materialSeams: seams.materialSeamCount,
    nonManifoldSeams: seams.nonManifoldCount,
    islandTrianglesMin: islandMin,
    islandTrianglesMedian: islandSizes.length > 0 ? percentile(islandSizes, 0.5) : 0,
    islandTrianglesMax: islandMax,
    densitySpreadBefore: Number(outcome.densitySpreadBefore.toFixed(6)),
    densitySpreadAfter: Number(chartSetDensitySpread(charts, face).toFixed(6)),
    densityRounds: outcome.densityRounds,
    densitySplits: outcome.densitySplits,
    densityUnresolved: outcome.densityUnresolved,
    islandMerges: outcome.islandMerges,
    refineRestarts: outcome.refineRestarts,
    cutAttempts: outcome.cutAttempts,
    islandBoundaryEdges: outcome.islandBoundaryEdges,
    refineTimeMs: Number(outcome.refineTimeMs.toFixed(1)),
    refineMsPerTask: outcome.refineRestarts > 0
      ? Number((outcome.refineTimeMs / outcome.refineRestarts).toFixed(3))
      : 0,
    refineWasmTasks: outcome.wasmTasks,
    refineTimedOut: outcome.refineTimedOut ? 1 : 0,
    refineStoppedEarly: outcome.refineStoppedEarly ? 1 : 0,
    layoutBBoxArea: Number(chartSetBBoxArea(charts).toFixed(6)),
    worldArea: Number(worldArea.toFixed(6)),
    uvArea: Number(uvArea.toFixed(6)),
  };

  return {
    charts,
    chartOfTriangle,
    seamEdge: seams.seamEdge,
    triangleUvs,
    stats,
    issues,
  };
}

/** Uniformly scales islands so the layout stays inside the unit square and
 * leaves room for packing gaps. The atlas fill inside the packer decides the
 * final texel density. */
export function fitSmartIslands(charts: ChartUv[], triangleUvs: Float32Array): SmartFitResult {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const chart of charts) {
    for (let index = 0; index < chart.uvs.length; index += 2) {
      minU = Math.min(minU, chart.uvs[index]);
      minV = Math.min(minV, chart.uvs[index + 1]);
      maxU = Math.max(maxU, chart.uvs[index]);
      maxV = Math.max(maxV, chart.uvs[index + 1]);
    }
  }
  const extent = Number.isFinite(minU) ? Math.max(maxU - minU, maxV - minV) : 0;
  let totalArea = 0;
  for (const chart of charts) totalArea += chart.uvArea;
  const extentScale = extent > AREA_EPSILON ? 1 / extent : 1;
  const areaScale = totalArea > AREA_EPSILON ? Math.sqrt(SMART_FIT_AREA_TARGET / totalArea) : 1;
  const scale = Math.min(extentScale, areaScale);
  if (scale === 1) return { scale, charts, triangleUvs };
  const scaledCharts = charts.map((chart) => {
    const uvs = new Float32Array(chart.uvs.length);
    for (let index = 0; index < chart.uvs.length; index += 1) uvs[index] = chart.uvs[index] * scale;
    return {
      ...chart,
      uvs,
      uvArea: chart.uvArea * scale * scale,
      bbox: {
        minU: chart.bbox.minU * scale,
        minV: chart.bbox.minV * scale,
        maxU: chart.bbox.maxU * scale,
        maxV: chart.bbox.maxV * scale,
      },
    };
  });
  const scaledUvs = new Float32Array(triangleUvs.length);
  for (let index = 0; index < triangleUvs.length; index += 1) scaledUvs[index] = triangleUvs[index] * scale;
  return { scale, charts: scaledCharts, triangleUvs: scaledUvs };
}

export type SmartDensityResult = {
  charts: ChartUv[];
  triangleUvs: Float32Array;
  density: number;
  scaleMin: number;
  scaleMax: number;
  scales: Float32Array;
};

/** Scales every island so all islands share one nominal texel density. */
export function equalizeSmartDensity(
  mesh: ConditionedMesh,
  charts: ChartUv[],
  face: FaceGeometry,
  resolution: number,
): SmartDensityResult {
  let targetDensity = 0;
  const chartMax: number[] = [];
  for (const chart of charts) {
    let max = 0;
    for (const density of chartFaceDensities(chart, face, 1)) {
      if (density > max) max = density;
    }
    chartMax.push(max);
    if (max > targetDensity) targetDensity = max;
  }
  let scaleMin = Infinity;
  let scaleMax = 0;
  const scales = new Float32Array(charts.length);
  const scaledCharts = charts.map((chart, chartIndex) => {
    const current = chartMax[chartIndex];
    const scale = targetDensity > 0 && current > 0 ? targetDensity / current : 1;
    scales[chart.chart] = scale;
    if (scale < scaleMin) scaleMin = scale;
    if (scale > scaleMax) scaleMax = scale;
    const uvs = new Float32Array(chart.uvs.length);
    for (let index = 0; index < chart.uvs.length; index += 1) uvs[index] = chart.uvs[index] * scale;
    return {
      ...chart,
      uvs,
      uvArea: chart.uvArea * scale * scale,
      bbox: {
        minU: chart.bbox.minU * scale,
        minV: chart.bbox.minV * scale,
        maxU: chart.bbox.maxU * scale,
        maxV: chart.bbox.maxV * scale,
      },
    };
  });
  if (!Number.isFinite(scaleMin)) scaleMin = 0;
  const triangleUvs = new Float32Array(mesh.triangleCount * 6);
  for (const chart of scaledCharts) {
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const triangle = chart.triangles[local];
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = chart.localIndices[local * 3 + corner];
        triangleUvs[triangle * 6 + corner * 2] = chart.uvs[vertex * 2];
        triangleUvs[triangle * 6 + corner * 2 + 1] = chart.uvs[vertex * 2 + 1];
      }
    }
  }
  return {
    charts: scaledCharts,
    triangleUvs,
    density: targetDensity * resolution,
    scaleMin,
    scaleMax,
    scales,
  };
}
