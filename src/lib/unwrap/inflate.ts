import type { FaceGeometry } from './mesh';
import { signedTriangleArea2D } from './metrics';
import {
  buildDensityArrays,
  chartFaceDensities,
  densitySpread,
} from './density';
import type {
  ChartUv,
  ConditionedMesh,
  DensityResult,
  InflateOptions,
  Issue,
  StageStats,
} from './types';

const EPSILON = 1e-12;

type InflatePass = {
  uvs: Float32Array;
  iterations: number;
  maxFactor: number;
  attempted: boolean;
};

/** Inflates the lowest-density face repeatedly with a small outward step.
 * Accepted steps are those that grow that face without folding the chart;
 * rejected faces are skipped and the next-smallest face is tried. */
function inflateChart(
  chart: ChartUv,
  face: FaceGeometry,
  resolution: number,
  reference: number,
  maxInflation: number,
  maxIterations: number,
): InflatePass {
  const count = chart.localVertex.length;
  if (count === 0 || reference <= 0) {
    return { uvs: chart.uvs, iterations: 0, maxFactor: 1, attempted: false };
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
  let maxFactor = 1;
  let iterations = 0;
  let attempted = false;
  const failed = new Uint8Array(chart.triangles.length);
  const areaScale = (reference * reference) / (resolution * resolution);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const forceU = new Float32Array(count);
    const forceV = new Float32Array(count);
    const faceDensities = chartFaceDensities(chart, face, resolution, uvs);
    let currentMin = Infinity;
    for (const density of faceDensities) {
      if (density > EPSILON) currentMin = Math.min(currentMin, density);
    }
    if (currentMin >= reference * 0.995) break;
    let lowest = -1;
    let lowestDensity = Infinity;
    for (let local = 0; local < chart.triangles.length; local += 1) {
      if (failed[local]) continue;
      if (faceDensities[local] > EPSILON && faceDensities[local] < lowestDensity) {
        lowestDensity = faceDensities[local];
        lowest = local;
      }
    }
    if (lowest < 0) break;
    const local = lowest;
    const a = chart.localIndices[local * 3] * 2;
    const b = chart.localIndices[local * 3 + 1] * 2;
    const c = chart.localIndices[local * 3 + 2] * 2;
    const area = Math.abs(signedTriangleArea2D(
      uvs[a], uvs[a + 1],
      uvs[b], uvs[b + 1],
      uvs[c], uvs[c + 1],
    ));
    const targetArea = face.areas[chart.triangles[local]] * areaScale;
    if (!(area > EPSILON) || !(targetArea > area)) {
      failed[local] = 1;
      continue;
    }
    const factor = Math.min(maxInflation, Math.sqrt(targetArea / area));
    if (factor <= 1.001) break;
    attempted = true;
    const cx = (uvs[a] + uvs[b] + uvs[c]) / 3;
    const cy = (uvs[a + 1] + uvs[b + 1] + uvs[c + 1]) / 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = chart.localIndices[local * 3 + corner];
      forceU[vertex] += (uvs[vertex * 2] - cx) * (factor - 1);
      forceV[vertex] += (uvs[vertex * 2 + 1] - cy) * (factor - 1);
    }
    const localMax = factor;
    const next = new Float32Array(uvs.length);
    for (let vertex = 0; vertex < count; vertex += 1) {
      next[vertex * 2] = uvs[vertex * 2] + forceU[vertex] * 0.02;
      next[vertex * 2 + 1] = uvs[vertex * 2 + 1] + forceV[vertex] * 0.02;
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
    }
    if (!valid) {
      failed[local] = 1;
      continue;
    }
    const nextFaceDensities = chartFaceDensities(chart, face, resolution, next);
    let nextMin = Infinity;
    for (const density of nextFaceDensities) {
      if (density > EPSILON) nextMin = Math.min(nextMin, density);
    }
    const nextLocalArea = Math.abs(signedTriangleArea2D(
      next[a], next[a + 1],
      next[b], next[b + 1],
      next[c], next[c + 1],
    ));
    if (nextLocalArea <= area + EPSILON || nextMin < currentMin - 1e-9) {
      failed[local] = 1;
      continue;
    }
    uvs = next;
    maxFactor = Math.max(maxFactor, localMax);
    iterations += 1;
  }
  return { uvs, iterations, maxFactor, attempted };
}

/** Inflation-only density pass. It runs after chart normalization and never
 * shrinks a chart; it raises the lowest-density face in each chart until the
 * average density or the iteration cap is reached. */
export function inflateDensity(
  mesh: ConditionedMesh,
  normalized: DensityResult,
  face: FaceGeometry,
  options: InflateOptions,
): DensityResult {
  const resolution = Math.max(1, Math.round(options.atlasResolution));
  const target = Math.max(0, options.targetTexelDensity);
  const maxInflation = options.maxInflation ?? 1.2;
  const maxIterations = Math.max(1, Math.round(options.maxIterations ?? 1024));
  const issues: Issue[] = [];
  if (options.atlasResolution <= 0 || options.targetTexelDensity <= 0) {
    issues.push({
      stage: 'inflate',
      severity: 'error',
      code: 'invalid-density',
      message: 'Atlas resolution and target texel density must be positive.',
    });
  }
  const charts: ChartUv[] = normalized.charts.map((chart) => ({
    ...chart,
    uvs: new Float32Array(chart.uvs),
    bbox: { ...chart.bbox },
  }));
  const densitiesBefore: number[] = [];
  for (const chart of charts) {
    densitiesBefore.push(...chartFaceDensities(chart, face, resolution));
  }
  let densitySum = 0;
  let densityCount = 0;
  let minimumBefore = Infinity;
  for (const density of densitiesBefore) {
    if (!(density > EPSILON)) continue;
    densitySum += density;
    densityCount += 1;
    minimumBefore = Math.min(minimumBefore, density);
  }
  const averageDensity = densityCount > 0 ? densitySum / densityCount : 0;
  const referenceDensity = target > 0 && averageDensity > 0
    ? averageDensity
    : Number(normalized.stats.densityP95 ?? 0);

  let inflatedCharts = 0;
  let attemptedCharts = 0;
  let inflationIterations = 0;
  let maxInflationApplied = 1;
  for (const chart of charts) {
    const inflated = inflateChart(chart, face, resolution, referenceDensity, maxInflation, maxIterations);
    if (inflated.attempted) attemptedCharts += 1;
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
    maxInflationApplied = Math.max(maxInflationApplied, inflated.maxFactor);
  }

  const densitiesAfter: number[] = [];
  let uvAreaFraction = 0;
  let minimumAfter = Infinity;
  for (const chart of charts) {
    const densities = chartFaceDensities(chart, face, resolution);
    for (const density of densities) {
      if (density > EPSILON) minimumAfter = Math.min(minimumAfter, density);
    }
    densitiesAfter.push(...densities);
    uvAreaFraction += chart.uvArea;
  }
  const arrays = buildDensityArrays(mesh, charts, face, resolution, target);

  if (inflatedCharts > 0) {
    issues.push({
      stage: 'inflate',
      severity: 'info',
      code: 'density-inflated',
      message: `Inflated ${inflatedCharts} of ${charts.length} chart${charts.length === 1 ? '' : 's'}.`,
      value: inflatedCharts,
    });
    if (averageDensity > 0 && minimumAfter < averageDensity * 0.995) {
      issues.push({
        stage: 'inflate',
        severity: 'info',
        code: 'density-inflation-limited',
        message: `Stopped at ${minimumAfter.toFixed(1)} px/unit; the lowest face is still below the ${averageDensity.toFixed(1)} px/unit average.`,
        value: Number(minimumAfter.toFixed(4)),
        threshold: Number(averageDensity.toFixed(4)),
      });
    }
  } else if (attemptedCharts > 0) {
    issues.push({
      stage: 'inflate',
      severity: 'info',
      code: 'density-inflation-blocked',
      message: `No chart could be inflated without lowering another face; ${attemptedCharts} chart${attemptedCharts === 1 ? '' : 's'} still have low-density faces.`,
      value: attemptedCharts,
    });
  } else {
    issues.push({
      stage: 'inflate',
      severity: 'info',
      code: 'density-already-uniform',
      message: 'Every face already meets the reference texel density.',
      value: 0,
    });
  }

  const stats: StageStats = {
    charts: charts.length,
    atlasResolution: resolution,
    targetDensity: target,
    averageDensity: Number(averageDensity.toFixed(4)),
    referenceDensity: Number(referenceDensity.toFixed(4)),
    minimumDensityBefore: Number((Number.isFinite(minimumBefore) ? minimumBefore : 0).toFixed(4)),
    minimumDensityAfter: Number((Number.isFinite(minimumAfter) ? minimumAfter : 0).toFixed(4)),
    densityBeforeSpread: Number(densitySpread(densitiesBefore).toFixed(6)),
    densityAfterSpread: Number(densitySpread(densitiesAfter).toFixed(6)),
    densityP50: Number(arrays.summary.p50.toFixed(4)),
    densityP95: Number(arrays.summary.p95.toFixed(4)),
    attemptedCharts,
    inflatedCharts,
    inflationIterations,
    maxInflation: Number(maxInflationApplied.toFixed(4)),
    uvAreaFraction: Number(uvAreaFraction.toFixed(6)),
  };

  return {
    charts,
    triangleUvs: arrays.triangleUvs,
    faceTexelDensity: arrays.faceTexelDensity,
    densityRatio: arrays.densityRatio,
    chartScales: normalized.chartScales,
    stats,
    issues,
  };
}
