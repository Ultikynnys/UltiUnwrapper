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

/** Inflates faces whose UV area is below the reference density. Only faces
 * with a deficit contribute force, the displacement is Laplacian-smoothed,
 * and each step is small, so dense faces stay fixed while sparse regions grow
 * smoothly. */
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
  let attempted = false;
  let currentSpread = densitySpread(chartFaceDensities(chart, face, resolution, uvs));
  const areaScale = (reference * reference) / (resolution * resolution);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
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
      attempted = true;
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
      next[vertex * 2] = uvs[vertex * 2] + forceU[vertex] * 0.01;
      next[vertex * 2 + 1] = uvs[vertex * 2 + 1] + forceV[vertex] * 0.01;
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
    if (!valid) break;
    const nextFaceDensities = chartFaceDensities(chart, face, resolution, next);
    let currentMin = Infinity;
    let nextMin = Infinity;
    for (let local = 0; local < faceDensities.length; local += 1) {
      if (faceDensities[local] > EPSILON) currentMin = Math.min(currentMin, faceDensities[local]);
      if (nextFaceDensities[local] > EPSILON) nextMin = Math.min(nextMin, nextFaceDensities[local]);
    }
    const nextSpread = densitySpread(nextFaceDensities);
    if (nextMin < currentMin - 1e-9 || nextArea <= totalArea + EPSILON || nextSpread >= currentSpread - 1e-9) break;
    uvs = next;
    totalArea = nextArea;
    currentSpread = nextSpread;
    maxFactor = Math.max(maxFactor, localMax);
    iterations += 1;
  }
  if (iterations === 0 && chart.triangles.length <= 4000) {
    const initialDensities = chartFaceDensities(chart, face, resolution, uvs);
    const order = Array.from({ length: chart.triangles.length }, (_, index) => index)
      .sort((a, b) => initialDensities[a] - initialDensities[b]);
    for (let pass = 0; pass < 8; pass += 1) {
      const baseDensities = chartFaceDensities(chart, face, resolution, uvs);
      const maxDensity = new Float32Array(count);
      for (let local = 0; local < chart.triangles.length; local += 1) {
        for (let corner = 0; corner < 3; corner += 1) {
          const vertex = chart.localIndices[local * 3 + corner];
          maxDensity[vertex] = Math.max(maxDensity[vertex], baseDensities[local]);
        }
      }
      const pinned = new Uint8Array(count);
      for (let vertex = 0; vertex < count; vertex += 1) {
        pinned[vertex] = maxDensity[vertex] >= reference * 1.15 ? 1 : 0;
      }
      let currentMin = Infinity;
      for (const density of baseDensities) {
        if (density > EPSILON) currentMin = Math.min(currentMin, density);
      }
      let accepted = false;
      for (const local of order) {
        if (!(baseDensities[local] > EPSILON) || baseDensities[local] >= reference) continue;
        const a = chart.localIndices[local * 3] * 2;
        const b = chart.localIndices[local * 3 + 1] * 2;
        const c = chart.localIndices[local * 3 + 2] * 2;
        const vertices = [
          chart.localIndices[local * 3],
          chart.localIndices[local * 3 + 1],
          chart.localIndices[local * 3 + 2],
        ];
        if (vertices.some((vertex) => pinned[vertex])) continue;
        const area = Math.abs(signedTriangleArea2D(
          uvs[a], uvs[a + 1],
          uvs[b], uvs[b + 1],
          uvs[c], uvs[c + 1],
        ));
        const targetArea = face.areas[chart.triangles[local]] * areaScale;
        if (!(area > EPSILON) || !(targetArea > area)) continue;
        const factor = Math.min(maxInflation, Math.sqrt(targetArea / area));
        const cx = (uvs[a] + uvs[b] + uvs[c]) / 3;
        const cy = (uvs[a + 1] + uvs[b + 1] + uvs[c + 1]) / 3;
        const trial = new Float32Array(uvs);
        for (const vertex of vertices) {
          trial[vertex * 2] = uvs[vertex * 2] + (uvs[vertex * 2] - cx) * (factor - 1) * 0.5;
          trial[vertex * 2 + 1] = uvs[vertex * 2 + 1] + (uvs[vertex * 2 + 1] - cy) * (factor - 1) * 0.5;
        }
        let valid = true;
        let trialArea = 0;
        for (let test = 0; test < chart.triangles.length; test += 1) {
          const ta = chart.localIndices[test * 3] * 2;
          const tb = chart.localIndices[test * 3 + 1] * 2;
          const tc = chart.localIndices[test * 3 + 2] * 2;
          const testArea = signedTriangleArea2D(
            trial[ta], trial[ta + 1],
            trial[tb], trial[tb + 1],
            trial[tc], trial[tc + 1],
          );
          const sign = testArea > EPSILON ? 1 : testArea < -EPSILON ? -1 : 0;
          if (initialSigns[test] !== 0 && sign !== initialSigns[test]) {
            valid = false;
            break;
          }
          trialArea += Math.abs(testArea);
        }
        if (!valid || trialArea <= totalArea + EPSILON) continue;
        const nextDensities = chartFaceDensities(chart, face, resolution, trial);
        let nextMin = Infinity;
        for (const density of nextDensities) {
          if (density > EPSILON) nextMin = Math.min(nextMin, density);
        }
        const nextSpread = densitySpread(nextDensities);
        if (nextMin < currentMin - 1e-9 || nextSpread >= currentSpread - 1e-9) continue;
        uvs = trial;
        totalArea = trialArea;
        currentSpread = nextSpread;
        maxFactor = Math.max(maxFactor, factor);
        iterations += 1;
        accepted = true;
        break;
      }
      if (!accepted) break;
    }
  }
  return { uvs, iterations, maxFactor, attempted };
}

/** Inflation-only density pass. It runs after chart normalization and never
 * shrinks a chart; a step is rejected when it lowers the minimum face density
 * or fails to reduce the spread. */
export function inflateDensity(
  mesh: ConditionedMesh,
  normalized: DensityResult,
  face: FaceGeometry,
  options: InflateOptions,
): DensityResult {
  const resolution = Math.max(1, Math.round(options.atlasResolution));
  const target = Math.max(0, options.targetTexelDensity);
  const maxInflation = options.maxInflation ?? 1.2;
  const maxIterations = Math.max(1, Math.round(options.maxIterations ?? 24));
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
  const referenceDensity = target > 0
    ? target
    : Number(normalized.stats.densityP95 ?? 0);

  const densitiesBefore: number[] = [];
  for (const chart of charts) {
    densitiesBefore.push(...chartFaceDensities(chart, face, resolution));
  }

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
  for (const chart of charts) {
    densitiesAfter.push(...chartFaceDensities(chart, face, resolution));
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
    referenceDensity: Number(referenceDensity.toFixed(4)),
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
