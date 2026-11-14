import type { FaceGeometry } from './mesh';
import { signedTriangleArea2D, summarize } from './metrics';
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
    const after = chart.worldArea > EPSILON && uvArea > EPSILON
      ? Math.sqrt((uvArea * resolutionSquared) / chart.worldArea)
      : 0;
    if (before > 0) densitiesBefore.push(before);
    if (after > 0) densitiesAfter.push(after);
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
