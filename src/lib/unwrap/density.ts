import type { FaceGeometry } from './mesh';
import { percentile, signedTriangleArea2D, summarize } from './metrics';
import type {
  ChartUv,
  ConditionedMesh,
  DensityOptions,
  DensityResult,
  Issue,
  ParameterizeResult,
  StageStats,
} from './types';

const EPSILON = 1e-12;

function spread(values: number[]): number {
  if (values.length === 0) return 0;
  let min = Infinity;
  let max = 0;
  for (const value of values) {
    if (!(value > 0)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || min <= 0) return 0;
  return max / min - 1;
}

function chartFaceDensities(
  chart: ChartUv,
  face: FaceGeometry,
  resolution: number,
  uvs: Float32Array = chart.uvs,
): number[] {
  const densities: number[] = [];
  for (let local = 0; local < chart.triangles.length; local += 1) {
    const a = chart.localIndices[local * 3] * 2;
    const b = chart.localIndices[local * 3 + 1] * 2;
    const c = chart.localIndices[local * 3 + 2] * 2;
    const uvArea = Math.abs(signedTriangleArea2D(
      uvs[a], uvs[a + 1],
      uvs[b], uvs[b + 1],
      uvs[c], uvs[c + 1],
    ));
    const worldArea = face.areas[chart.triangles[local]];
    densities.push(uvArea > EPSILON && worldArea > EPSILON
      ? Math.sqrt((uvArea * resolution * resolution) / worldArea)
      : 0);
  }
  return densities;
}

/** Inflates faces whose UV area is below the target. Only faces with a deficit
 * contribute force, the displacement is Laplacian-smoothed, and the step is
 * small, so dense faces stay fixed while sparse regions grow smoothly. */
function inflateChart(
  chart: ChartUv,
  face: FaceGeometry,
  resolution: number,
  reference: number,
  maxInflation: number,
): { uvs: Float32Array; iterations: number; maxFactor: number } {
  const count = chart.localVertex.length;
  if (count === 0 || reference <= 0) {
    return { uvs: chart.uvs, iterations: 0, maxFactor: 1 };
  }
  const adjacency: number[][] = Array.from({ length: count }, () => []);
  for (let local = 0; local < chart.triangles.length; local += 1) {
    const a = chart.localIndices[local * 3];
    const b = chart.localIndices[local * 3 + 1];
    const c = chart.localIndices[local * 3 + 2];
    adjacency[a].push(b, c);
    adjacency[b].push(a, c);
    adjacency[c].push(a, b);
  }
  const initialSigns = new Int8Array(chart.triangles.length);
  for (let local = 0; local < chart.triangles.length; local += 1) {
    const a = chart.localIndices[local * 3] * 2;
    const b = chart.localIndices[local * 3 + 1] * 2;
    const c = chart.localIndices[local * 3 + 2] * 2;
    const area = signedTriangleArea2D(
      chart.uvs[a], chart.uvs[a + 1],
      chart.uvs[b], chart.uvs[b + 1],
      chart.uvs[c], chart.uvs[c + 1],
    );
    initialSigns[local] = area > EPSILON ? 1 : area < -EPSILON ? -1 : 0;
  }
  let uvs = new Float32Array(chart.uvs);
  let totalArea = chart.uvArea;
  let maxFactor = 1;
  let iterations = 0;
  let currentSpread = spread(chartFaceDensities(chart, face, resolution, uvs));
  const areaScale = (reference * reference) / (resolution * resolution);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const forceU = new Float32Array(count);
    const forceV = new Float32Array(count);
    const pinned = new Uint8Array(count);
    const faceDensities = chartFaceDensities(chart, face, resolution, uvs);
    const maxDensity = new Float32Array(count);
    for (let local = 0; local < chart.triangles.length; local += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = chart.localIndices[local * 3 + corner];
        maxDensity[vertex] = Math.max(maxDensity[vertex], faceDensities[local]);
      }
    }
    for (let vertex = 0; vertex < count; vertex += 1) {
      pinned[vertex] = maxDensity[vertex] >= reference * 1.15 ? 1 : 0;
    }
    let localMax = 1;
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const a = chart.localIndices[local * 3] * 2;
      const b = chart.localIndices[local * 3 + 1] * 2;
      const c = chart.localIndices[local * 3 + 2] * 2;
      const area = Math.abs(signedTriangleArea2D(
        uvs[a], uvs[a + 1],
        uvs[b], uvs[b + 1],
        uvs[c], uvs[c + 1],
      ));
      const targetArea = face.areas[chart.triangles[local]] * areaScale;
      if (!(area > EPSILON) || !(targetArea > area)) continue;
      const factor = Math.min(maxInflation, Math.sqrt(targetArea / area));
      localMax = Math.max(localMax, factor);
      const cx = (uvs[a] + uvs[b] + uvs[c]) / 3;
      const cy = (uvs[a + 1] + uvs[b + 1] + uvs[c + 1]) / 3;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = chart.localIndices[local * 3 + corner];
        if (pinned[vertex]) continue;
        forceU[vertex] += (uvs[vertex * 2] - cx) * (factor - 1);
        forceV[vertex] += (uvs[vertex * 2 + 1] - cy) * (factor - 1);
      }
    }
    if (localMax <= 1.001) break;
    for (let pass = 0; pass < 2; pass += 1) {
      const smoothU = new Float32Array(forceU);
      const smoothV = new Float32Array(forceV);
      for (let vertex = 0; vertex < count; vertex += 1) {
        const neighbors = adjacency[vertex];
        let sumU = forceU[vertex];
        let sumV = forceV[vertex];
        for (const neighbor of neighbors) {
          sumU += forceU[neighbor];
          sumV += forceV[neighbor];
        }
        smoothU[vertex] = forceU[vertex] * 0.7 + (sumU / (neighbors.length + 1)) * 0.3;
        smoothV[vertex] = forceV[vertex] * 0.7 + (sumV / (neighbors.length + 1)) * 0.3;
      }
      for (let vertex = 0; vertex < count; vertex += 1) {
        if (pinned[vertex]) {
          smoothU[vertex] = 0;
          smoothV[vertex] = 0;
        }
      }
      forceU.set(smoothU);
      forceV.set(smoothV);
    }
    const next = new Float32Array(uvs.length);
    let nextArea = 0;
    for (let vertex = 0; vertex < count; vertex += 1) {
      next[vertex * 2] = uvs[vertex * 2] + forceU[vertex] * 0.35;
      next[vertex * 2 + 1] = uvs[vertex * 2 + 1] + forceV[vertex] * 0.35;
    }
    let valid = true;
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const a = chart.localIndices[local * 3] * 2;
      const b = chart.localIndices[local * 3 + 1] * 2;
      const c = chart.localIndices[local * 3 + 2] * 2;
      const area = signedTriangleArea2D(
        next[a], next[a + 1],
        next[b], next[b + 1],
        next[c], next[c + 1],
      );
      const sign = area > EPSILON ? 1 : area < -EPSILON ? -1 : 0;
      if (initialSigns[local] !== 0 && sign !== initialSigns[local]) {
        valid = false;
        break;
      }
      nextArea += Math.abs(area);
    }
    const nextSpread = spread(chartFaceDensities(chart, face, resolution, next));
    if (!valid || nextArea <= totalArea + EPSILON || nextSpread >= currentSpread - 1e-9) break;
    uvs = next;
    totalArea = nextArea;
    currentSpread = nextSpread;
    maxFactor = Math.max(maxFactor, localMax);
    iterations += 1;
  }
  return { uvs, iterations, maxFactor };
}

/** Re-scales every chart so its texel density equals the target. The output UVs
 * are atlas fractions: a chart at target density occupies `worldArea *
 * (target / resolution)^2` of the atlas. Packing may later scale every chart
 * down uniformly if the target does not fit. */
export function normalizeDensity(
  mesh: ConditionedMesh,
  parameterization: ParameterizeResult,
  face: FaceGeometry,
  options: DensityOptions,
): DensityResult {
  const resolution = Math.max(1, Math.round(options.atlasResolution));
  const target = Math.max(0, options.targetTexelDensity);
  const minScale = options.minChartScale ?? 1e-4;
  const maxScale = options.maxChartScale ?? 1e4;
  const resolutionSquared = resolution * resolution;
  const issues: Issue[] = [];
  const charts: ChartUv[] = [];
  const chartScales = new Float32Array(parameterization.charts.length);

  if (options.atlasResolution <= 0 || options.targetTexelDensity <= 0) {
    issues.push({
      stage: 'normalize',
      severity: 'error',
      code: 'invalid-density',
      message: 'Atlas resolution and target texel density must be positive.',
    });
  }

  let clampedCharts = 0;
  let degenerateCharts = 0;
  const densitiesBefore: number[] = [];
  const densitiesAfter: number[] = [];

  for (const chart of parameterization.charts) {
    let scale = 1;
    const before = chart.worldArea > EPSILON && chart.uvArea > EPSILON
      ? Math.sqrt((chart.uvArea * resolutionSquared) / chart.worldArea)
      : 0;
    if (before > 0 && target > 0) {
      scale = target / before;
      const clamped = Math.min(maxScale, Math.max(minScale, scale));
      if (clamped !== scale) clampedCharts += 1;
      scale = clamped;
    } else {
      degenerateCharts += 1;
    }
    const uvs = new Float32Array(chart.uvs.length);
    for (let value = 0; value < chart.uvs.length; value += 1) uvs[value] = chart.uvs[value] * scale;
    const uvArea = chart.uvArea * scale * scale;
    chartScales[chart.chart] = scale;
    charts.push({
      ...chart,
      uvs,
      uvArea,
      bbox: {
        minU: chart.bbox.minU * scale,
        minV: chart.bbox.minV * scale,
        maxU: chart.bbox.maxU * scale,
        maxV: chart.bbox.maxV * scale,
      },
    });
  }

  for (const chart of charts) {
    densitiesBefore.push(...chartFaceDensities(chart, face, resolution));
  }
  const referenceDensity = target > 0
    ? target
    : percentile(densitiesBefore, 0.95);
  let inflatedCharts = 0;
  let inflationIterations = 0;
  let maxInflation = 1;
  for (const chart of charts) {
    const inflated = inflateChart(chart, face, resolution, referenceDensity, 1.2);
    if (inflated.iterations === 0) continue;
    let area = 0;
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const a = chart.localIndices[local * 3] * 2;
      const b = chart.localIndices[local * 3 + 1] * 2;
      const c = chart.localIndices[local * 3 + 2] * 2;
      area += Math.abs(signedTriangleArea2D(
        inflated.uvs[a], inflated.uvs[a + 1],
        inflated.uvs[b], inflated.uvs[b + 1],
        inflated.uvs[c], inflated.uvs[c + 1],
      ));
    }
    for (let vertex = 0; vertex < inflated.uvs.length / 2; vertex += 1) {
      minU = Math.min(minU, inflated.uvs[vertex * 2]);
      minV = Math.min(minV, inflated.uvs[vertex * 2 + 1]);
      maxU = Math.max(maxU, inflated.uvs[vertex * 2]);
      maxV = Math.max(maxV, inflated.uvs[vertex * 2 + 1]);
    }
    chart.uvs = inflated.uvs;
    chart.uvArea = area;
    chart.bbox = { minU, minV, maxU, maxV };
    inflatedCharts += 1;
    inflationIterations = Math.max(inflationIterations, inflated.iterations);
    maxInflation = Math.max(maxInflation, inflated.maxFactor);
  }
  for (const chart of charts) {
    densitiesAfter.push(...chartFaceDensities(chart, face, resolution));
  }

  const triangleUvs = new Float32Array(mesh.triangleCount * 6);
  const faceTexelDensity = new Float32Array(mesh.triangleCount);
  const densityRatio = new Float32Array(mesh.triangleCount);
  for (const chart of charts) {
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const triangle = chart.triangles[local];
      const a = chart.localIndices[local * 3];
      const b = chart.localIndices[local * 3 + 1];
      const c = chart.localIndices[local * 3 + 2];
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = corner === 0 ? a : corner === 1 ? b : c;
        triangleUvs[triangle * 6 + corner * 2] = chart.uvs[vertex * 2];
        triangleUvs[triangle * 6 + corner * 2 + 1] = chart.uvs[vertex * 2 + 1];
      }
      const uvArea = Math.abs(signedTriangleArea2D(
        chart.uvs[a * 2], chart.uvs[a * 2 + 1],
        chart.uvs[b * 2], chart.uvs[b * 2 + 1],
        chart.uvs[c * 2], chart.uvs[c * 2 + 1],
      ));
      const worldArea = face.areas[triangle];
      const density = uvArea > EPSILON && worldArea > EPSILON
        ? Math.sqrt((uvArea * resolutionSquared) / worldArea)
        : 0;
      faceTexelDensity[triangle] = density;
      densityRatio[triangle] = target > 0 ? density / target : 0;
    }
  }

  let requiredAreaFraction = 0;
  let scaleMin = Infinity;
  let scaleMax = 0;
  for (const chart of charts) {
    requiredAreaFraction += chart.uvArea;
    if (chartScales[chart.chart] < scaleMin) scaleMin = chartScales[chart.chart];
    if (chartScales[chart.chart] > scaleMax) scaleMax = chartScales[chart.chart];
  }
  if (!Number.isFinite(scaleMin)) scaleMin = 0;

  if (requiredAreaFraction > 1 + 1e-6) {
    issues.push({
      stage: 'normalize',
      severity: 'warn',
      code: 'target-density-does-not-fit',
      message: `Target density needs ${(requiredAreaFraction * 100).toFixed(1)}% of the atlas before packing.`,
      value: Number(requiredAreaFraction.toFixed(6)),
      threshold: 1,
    });
  }
  if (clampedCharts > 0) {
    issues.push({
      stage: 'normalize',
      severity: 'warn',
      code: 'density-clamped',
      message: `${clampedCharts} chart scale${clampedCharts === 1 ? '' : 's'} were clamped.`,
      value: clampedCharts,
    });
  }
  if (degenerateCharts > 0) {
    issues.push({
      stage: 'normalize',
      severity: 'error',
      code: 'degenerate-chart',
      message: `${degenerateCharts} chart${degenerateCharts === 1 ? '' : 's'} have no usable UV or world area.`,
      value: degenerateCharts,
    });
  }

  const densitySummary = summarize(faceTexelDensity);
  const stats: StageStats = {
    charts: charts.length,
    atlasResolution: resolution,
    targetDensity: target,
    requiredAreaFraction: Number(requiredAreaFraction.toFixed(6)),
    densityBeforeSpread: Number(spread(densitiesBefore).toFixed(6)),
    densityAfterSpread: Number(spread(densitiesAfter).toFixed(6)),
    densityP50: Number(densitySummary.p50.toFixed(4)),
    densityP95: Number(densitySummary.p95.toFixed(4)),
    referenceDensity: Number(referenceDensity.toFixed(4)),
    inflatedCharts,
    inflationIterations,
    maxInflation: Number(maxInflation.toFixed(4)),
    scaleMin: Number(scaleMin.toFixed(6)),
    scaleMax: Number(scaleMax.toFixed(6)),
    clampedCharts,
  };

  return {
    charts,
    triangleUvs,
    faceTexelDensity,
    densityRatio,
    chartScales,
    stats,
    issues,
  };
}
