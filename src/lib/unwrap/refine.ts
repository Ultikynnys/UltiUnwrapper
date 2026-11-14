import {
  findBoundaryCut,
  findChartBisection,
  findClosedChartCut,
  segmentFromSeams,
  type SegmentOptions,
} from './charts';
import { parameterizeMesh } from './parameterize';
import { computeSeams, type SeamResult } from './seams';
import { edgeLength } from './topology';
import type { FaceGeometry } from './mesh';
import type {
  Chart,
  ChartUv,
  ConditionedMesh,
  MeshTopology,
  ParameterizeResult,
  Segmentation,
} from './types';

export type RefineOptions = SegmentOptions & {
  /** Largest allowed spread of triangle texel density inside one chart. */
  maxDensitySpread: number;
  /** Cut rounds before giving up. Default 12. */
  maxRounds?: number;
  /** Chart cap; refinement stops before going past it. Default 4096. */
  maxCharts?: number;
  /** Do not bisect charts smaller than this. Default 64 triangles. */
  minChartTriangles?: number;
  tolerance?: number;
  maxIterations?: number;
  maxFlippedFraction?: number;
};

export type RefineResult = {
  segmentation: Segmentation;
  parameterization: ParameterizeResult;
  /** Cut rounds that ran, including the final check. */
  rounds: number;
  /** Seams added by refinement, on top of the configured seams. */
  addedSeams: number;
  /** Charts still outside the quality budget when refinement stopped. */
  unresolved: number;
  /** True when refinement stopped before every chart was inside budget. */
  stalled: boolean;
  segmentMs: number;
  parameterizeMs: number;
};

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Spread of triangle texel density inside one chart. Density is measured in
 * world units here, so the atlas scale cancels out. */
function chartDensitySpread(face: FaceGeometry, chart: Chart, uv: ChartUv): number {
  let min = Infinity;
  let max = 0;
  for (let local = 0; local < chart.triangles.length; local += 1) {
    const triangle = chart.triangles[local];
    const a = uv.localIndices[local * 3] * 2;
    const b = uv.localIndices[local * 3 + 1] * 2;
    const c = uv.localIndices[local * 3 + 2] * 2;
    const uvArea = Math.abs(0.5 * (
      (uv.uvs[b] - uv.uvs[a]) * (uv.uvs[c + 1] - uv.uvs[a + 1])
      - (uv.uvs[c] - uv.uvs[a]) * (uv.uvs[b + 1] - uv.uvs[a + 1])
    ));
    const worldArea = face.areas[triangle];
    if (!(uvArea > 0) || !(worldArea > 0)) continue;
    const density = Math.sqrt(uvArea / worldArea);
    if (density < min) min = density;
    if (density > max) max = density;
  }
  if (!Number.isFinite(min) || !(min > 0)) return 0;
  return max / min - 1;
}

/** Adds one geodesic cut to a failing chart. Closed and multi-loop charts
 * reuse the topology-opening cuts; an open disk is bisected between two
 * boundary vertices. Returns the number of new seams and their length. */
function cutFailingChart(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  chart: Chart,
  seamEdge: Uint8Array,
): { added: number; length: number } {
  const path = chart.closed
    ? findClosedChartCut(mesh, topology, chart, seamEdge)
    : chart.boundaryComponents > 1
      ? findBoundaryCut(mesh, topology, chart, seamEdge)
      : findChartBisection(mesh, topology, chart, seamEdge);
  let added = 0;
  let length = 0;
  for (const edgeIndex of path) {
    if (seamEdge[edgeIndex]) continue;
    seamEdge[edgeIndex] = 1;
    added += 1;
    length += edgeLength(mesh, topology.edges[edgeIndex]);
  }
  return { added, length };
}

/** Segments, flattens, and cuts again until every chart is flattened inside
 * the density budget, the chart cap is reached, or the round budget runs out.
 * Charts that never flatten are reported by the parameterize stage, so this
 * function never fabricates a layout. */
export function refineUnwrap(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  face: FaceGeometry,
  options: RefineOptions,
): RefineResult {
  const rounds = Math.max(1, options.maxRounds ?? 12);
  const maxCharts = Math.max(1, options.maxCharts ?? 4096);
  const minChartTriangles = Math.max(1, options.minChartTriangles ?? 64);
  const seams: SeamResult = computeSeams(mesh, topology, face, options);
  const seamEdge = new Uint8Array(seams.seamEdge);
  const budget = Math.max(0, options.maxDensitySpread);

  let segmentation: Segmentation | null = null;
  let parameterization: ParameterizeResult | null = null;
  let segmentMs = 0;
  let parameterizeMs = 0;
  let addedSeams = 0;
  let unresolved = 0;
  let stalled = false;
  let usedRounds = 0;

  for (let round = 0; round < rounds; round += 1) {
    usedRounds = round + 1;
    const segmentStart = clock();
    const currentSegmentation = segmentFromSeams(
      mesh,
      topology,
      face,
      seamEdge,
      options,
      seams,
    );
    segmentMs += clock() - segmentStart;
    const parameterizeStart = clock();
    const currentParameterization = parameterizeMesh(mesh, currentSegmentation, face, topology, {
      tolerance: options.tolerance,
      maxIterations: options.maxIterations,
      maxFlippedFraction: options.maxFlippedFraction,
    });
    parameterizeMs += clock() - parameterizeStart;
    segmentation = currentSegmentation;
    parameterization = currentParameterization;

    const failing: Chart[] = [];
    for (let index = 0; index < currentSegmentation.charts.length; index += 1) {
      const chart = currentSegmentation.charts[index];
      const uv = currentParameterization.charts[index];
      if (!uv || uv.failed) {
        failing.push(chart);
        continue;
      }
      if (chartDensitySpread(face, chart, uv) > budget) failing.push(chart);
    }
    unresolved = failing.length;
    stalled = failing.length > 0;
    if (failing.length === 0) break;
    if (currentSegmentation.charts.length >= maxCharts) break;

    let addedThisRound = 0;
    for (const chart of failing) {
      if (chart.triangles.length < minChartTriangles) continue;
      const cut = cutFailingChart(mesh, topology, chart, seamEdge);
      addedThisRound += cut.added;
      seams.interiorSeamCount += cut.added;
      seams.interiorSeamLength += cut.length;
    }
    addedSeams += addedThisRound;
    if (addedThisRound === 0) break;
  }

  if (!segmentation || !parameterization) {
    throw new Error('Refinement ran no rounds.');
  }
  return {
    segmentation,
    parameterization,
    rounds: usedRounds,
    addedSeams,
    unresolved,
    stalled,
    segmentMs,
    parameterizeMs,
  };
}
