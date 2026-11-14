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

/** Scales every triangle below the reference density around its own UV
 * centroid. Each accepted step raises that triangle without folding the chart
 * or increasing the maximum density, and passes repeat until no triangle can
 * grow. */
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
  const areaScale = (reference * reference) / (resolution * resolution);
  for (let pass = 0; pass < maxIterations; pass += 1) {
    const faceDensities = chartFaceDensities(chart, face, resolution, uvs);
    const affected: number[] = [];
    for (let local = 0; local < chart.triangles.length; local += 1) {
      if (faceDensities[local] > EPSILON && faceDensities[local] < reference * 0.995) {
        affected.push(local);
      }
    }
    if (affected.length === 0) break;
    affected.sort((a, b) => faceDensities[a] - faceDensities[b]);
    let currentMin = Infinity;
    let currentMax = 0;
    for (const density of faceDensities) {
      if (density > EPSILON) currentMin = Math.min(currentMin, density);
      if (density > currentMax) currentMax = density;
    }
    let accepted = 0;
    for (const local of affected) {
      const a = chart.localIndices[local * 3] * 2;
      const b = chart.localIndices[local * 3 + 1] * 2;
      const c = chart.localIndices[local * 3 + 2] * 2;
      const density = faceDensities[local];
      if (!(density > EPSILON) || density >= reference * 0.995) continue;
      const area = Math.abs(signedTriangleArea2D(
        uvs[a], uvs[a + 1],
        uvs[b], uvs[b + 1],
        uvs[c], uvs[c + 1],
      ));
      const targetArea = face.areas[chart.triangles[local]] * areaScale;
      if (!(area > EPSILON) || !(targetArea > area)) continue;
      attempted = true;
      const factor = Math.min(maxInflation, Math.sqrt(targetArea / area));
      const stepScale = 1 + (factor - 1) * 0.2;
      const cx = (uvs[a] + uvs[b] + uvs[c]) / 3;
      const cy = (uvs[a + 1] + uvs[b + 1] + uvs[c + 1]) / 3;
      const next = new Float32Array(uvs);
      const vertices = [
        chart.localIndices[local * 3],
        chart.localIndices[local * 3 + 1],
        chart.localIndices[local * 3 + 2],
      ];
      for (const vertex of vertices) {
        next[vertex * 2] = cx + (uvs[vertex * 2] - cx) * stepScale;
        next[vertex * 2 + 1] = cy + (uvs[vertex * 2 + 1] - cy) * stepScale;
      }
      let valid = true;
      for (let test = 0; test < chart.triangles.length; test += 1) {
        const ta = chart.localIndices[test * 3] * 2;
        const tb = chart.localIndices[test * 3 + 1] * 2;
        const tc = chart.localIndices[test * 3 + 2] * 2;
        const testArea = signedTriangleArea2D(
          next[ta], next[ta + 1],
          next[tb], next[tb + 1],
          next[tc], next[tc + 1],
        );
        const sign = testArea > EPSILON ? 1 : testArea < -EPSILON ? -1 : 0;
        if (initialSigns[test] !== 0 && sign !== initialSigns[test]) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      const nextDensities = chartFaceDensities(chart, face, resolution, next);
      let nextMin = Infinity;
      let nextMax = 0;
      for (const value of nextDensities) {
        if (value > EPSILON) nextMin = Math.min(nextMin, value);
        if (value > nextMax) nextMax = value;
      }
      if (!(nextDensities[local] > density + 1e-6)
        || nextMin < currentMin - 1e-9
        || nextMax > currentMax + 1e-6) continue;
      uvs = next;
      maxFactor = Math.max(maxFactor, factor);
      iterations += 1;
      accepted += 1;
    }
    if (accepted === 0) break;
  }
  return { uvs, iterations, maxFactor, attempted };
}

/** Inflation-only density pass. It runs after chart normalization and never
 * shrinks a chart; it scales low-density triangles around their centers until
 * they approach the average density or no safe scale remains. */
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
  const beforeByTriangle = new Float32Array(mesh.triangleCount);
  for (const chart of charts) {
    const densities = chartFaceDensities(chart, face, resolution);
    for (let local = 0; local < densities.length; local += 1) {
      densitiesBefore.push(densities[local]);
      beforeByTriangle[chart.triangles[local]] = densities[local];
    }
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
  let inflatedFaces = 0;
  let inflatedVertices = 0;
  for (let chartIndex = 0; chartIndex < charts.length; chartIndex += 1) {
    const chart = charts[chartIndex];
    const beforeChart = normalized.charts[chartIndex];
    const vertexCount = chart.uvs.length / 2;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      if (beforeChart
        && (Math.abs(beforeChart.uvs[vertex * 2] - chart.uvs[vertex * 2]) > 1e-9
          || Math.abs(beforeChart.uvs[vertex * 2 + 1] - chart.uvs[vertex * 2 + 1]) > 1e-9)) {
        inflatedVertices += 1;
      }
    }
    const densities = chartFaceDensities(chart, face, resolution);
    for (let local = 0; local < densities.length; local += 1) {
      const triangle = chart.triangles[local];
      if (densities[local] > beforeByTriangle[triangle] + 1e-6) inflatedFaces += 1;
      if (densities[local] > EPSILON) minimumAfter = Math.min(minimumAfter, densities[local]);
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
    inflatedFaces,
    inflatedVertices,
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
