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
  Issue,
  RelaxOptions,
  RelaxPassSample,
  StageStats,
} from './types';

const EPSILON = 1e-12;

function densityDifference(values: number[], reference: number): number {
  if (!(reference > EPSILON) || values.length === 0) return 0;
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (!(value > EPSILON)) continue;
    total += Math.abs(value / reference - 1);
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

function angleAt(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const uLength = Math.hypot(ux, uy, uz);
  const vLength = Math.hypot(vx, vy, vz);
  if (uLength <= EPSILON || vLength <= EPSILON) return 0;
  const cosine = (ux * vx + uy * vy + uz * vz) / (uLength * vLength);
  return (Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI;
}

type RelaxPass = {
  uvs: Float32Array;
  iterations: number;
  passes: number;
  smoothingPasses: number;
  angleBefore: number;
  angleAfter: number;
  maxFactor: number;
  attempted: boolean;
  history: RelaxPassSample[];
  differenceBefore: number;
  differenceAfter: number;
};

/** Scales every triangle below the reference density around its own UV
 * centroid. Each accepted step raises that triangle without folding the chart
 * or increasing the maximum density, and passes repeat until no triangle can
 * grow. */
function relaxChart(
  mesh: ConditionedMesh,
  chart: ChartUv,
  face: FaceGeometry,
  resolution: number,
  reference: number,
  maxExpansion: number,
  maxIterations: number,
): RelaxPass {
  const count = chart.localVertex.length;
  if (count === 0 || reference <= 0) {
    return { uvs: chart.uvs, iterations: 0, passes: 0, smoothingPasses: 0, angleBefore: 0, angleAfter: 0, maxFactor: 1, attempted: false, history: [], differenceBefore: 0, differenceAfter: 0 };
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
  let passes = 0;
  let attempted = false;
  const history: RelaxPassSample[] = [];
  const initialDensities = chartFaceDensities(chart, face, resolution, uvs);
  const differenceBefore = densityDifference(initialDensities, reference);
  const vertexTriangles: number[][] = Array.from({ length: count }, () => []);
  for (let local = 0; local < chart.triangles.length; local += 1) {
    vertexTriangles[chart.localIndices[local * 3]].push(local);
    vertexTriangles[chart.localIndices[local * 3 + 1]].push(local);
    vertexTriangles[chart.localIndices[local * 3 + 2]].push(local);
  }
  let currentDifference = differenceBefore;
  for (let pass = 0; pass < maxIterations; pass += 1) {
    let passDensities = chartFaceDensities(chart, face, resolution, uvs);
    const affected: number[] = [];
    for (let local = 0; local < chart.triangles.length; local += 1) {
      if (passDensities[local] > EPSILON && passDensities[local] < reference * 0.995) {
        affected.push(local);
      }
    }
    if (affected.length === 0) break;
    affected.sort((a, b) => passDensities[a] - passDensities[b]);
    const low = new Uint8Array(chart.triangles.length);
    for (const local of affected) low[local] = 1;
    const visited = new Uint8Array(chart.triangles.length);
    let accepted = 0;
    for (const seed of affected) {
      if (visited[seed]) continue;
      const region: number[] = [];
      const vertices = new Set<number>();
      const queue = [seed];
      visited[seed] = 1;
      while (queue.length > 0) {
        const local = queue.pop() as number;
        region.push(local);
        for (let corner = 0; corner < 3; corner += 1) {
          const vertex = chart.localIndices[local * 3 + corner];
          if (!vertices.has(vertex)) {
            vertices.add(vertex);
            for (const neighbor of vertexTriangles[vertex]) {
              if (low[neighbor] && !visited[neighbor]) {
                visited[neighbor] = 1;
                queue.push(neighbor);
              }
            }
          }
        }
      }
      let regionDensity = 0;
      for (const local of region) regionDensity += passDensities[local];
      regionDensity /= region.length;
      if (!(regionDensity > EPSILON) || regionDensity >= reference * 0.995) continue;
      attempted = true;
      const desired = Math.min(maxExpansion, Math.sqrt(reference / regionDensity));
      if (!(desired > 1 + 1e-9)) continue;
      let cx = 0;
      let cy = 0;
      for (const vertex of vertices) {
        cx += uvs[vertex * 2];
        cy += uvs[vertex * 2 + 1];
      }
      cx /= vertices.size;
      cy /= vertices.size;
      let applied = false;
      for (const factor of [desired, 1 + (desired - 1) * 0.5, 1 + (desired - 1) * 0.25]) {
        if (!(factor > 1 + 1e-9)) continue;
        const next = new Float32Array(uvs);
        for (const vertex of vertices) {
          next[vertex * 2] = cx + (uvs[vertex * 2] - cx) * factor;
          next[vertex * 2 + 1] = cy + (uvs[vertex * 2 + 1] - cy) * factor;
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
        const nextDifference = densityDifference(nextDensities, reference);
        if (!(nextDifference < currentDifference - 1e-9)) continue;
        uvs = next;
        passDensities = nextDensities;
        currentDifference = nextDifference;
        maxFactor = Math.max(maxFactor, factor);
        iterations += region.length;
        accepted += 1;
        applied = true;
        break;
      }
      if (applied) continue;
    }
    if (accepted === 0) break;
    passes += 1;
    let passMin = Infinity;
    let passMax = 0;
    for (const value of passDensities) {
      if (value > EPSILON) passMin = Math.min(passMin, value);
      if (value > passMax) passMax = value;
    }
    history.push({
      pass: passes,
      chart: chart.chart,
      difference: Number(currentDifference.toFixed(8)),
      spread: Number(densitySpread(passDensities).toFixed(6)),
      minDensity: Number((Number.isFinite(passMin) ? passMin : 0).toFixed(4)),
      maxDensity: Number(passMax.toFixed(4)),
    });
  }

  const worldAngles = new Float32Array(chart.triangles.length * 3);
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
    worldAngles[local * 3] = angleAt(ax, ay, az, bx, by, bz, cx, cy, cz);
    worldAngles[local * 3 + 1] = angleAt(bx, by, bz, cx, cy, cz, ax, ay, az);
    worldAngles[local * 3 + 2] = 180 - worldAngles[local * 3] - worldAngles[local * 3 + 1];
  }
  const uvAngleScore = (candidate: Float32Array): number => {
    let total = 0;
    let count = 0;
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const a = chart.localIndices[local * 3] * 2;
      const b = chart.localIndices[local * 3 + 1] * 2;
      const c = chart.localIndices[local * 3 + 2] * 2;
      const ua = angleAt(candidate[a], candidate[a + 1], 0, candidate[b], candidate[b + 1], 0, candidate[c], candidate[c + 1], 0);
      const ub = angleAt(candidate[b], candidate[b + 1], 0, candidate[c], candidate[c + 1], 0, candidate[a], candidate[a + 1], 0);
      const uc = 180 - ua - ub;
      total += Math.abs(ua - worldAngles[local * 3])
        + Math.abs(ub - worldAngles[local * 3 + 1])
        + Math.abs(uc - worldAngles[local * 3 + 2]);
      count += 3;
    }
    return count > 0 ? total / count : 0;
  };
  const adjacency: number[][] = Array.from({ length: count }, () => []);
  for (let local = 0; local < chart.triangles.length; local += 1) {
    const a = chart.localIndices[local * 3];
    const b = chart.localIndices[local * 3 + 1];
    const c = chart.localIndices[local * 3 + 2];
    adjacency[a].push(b, c);
    adjacency[b].push(a, c);
    adjacency[c].push(a, b);
  }
  const angleBefore = uvAngleScore(uvs);
  let smoothingPasses = 0;
  let angleAfter = angleBefore;
  for (let smoothPass = 0; smoothPass < 20; smoothPass += 1) {
    const next = new Float32Array(uvs);
    for (let vertex = 0; vertex < count; vertex += 1) {
      const neighbors = adjacency[vertex];
      if (neighbors.length === 0) continue;
      let sumU = 0;
      let sumV = 0;
      for (const neighbor of neighbors) {
        sumU += uvs[neighbor * 2];
        sumV += uvs[neighbor * 2 + 1];
      }
      next[vertex * 2] = uvs[vertex * 2] * 0.8 + (sumU / neighbors.length) * 0.2;
      next[vertex * 2 + 1] = uvs[vertex * 2 + 1] * 0.8 + (sumV / neighbors.length) * 0.2;
    }
    let nextArea = 0;
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const a = chart.localIndices[local * 3] * 2;
      const b = chart.localIndices[local * 3 + 1] * 2;
      const c = chart.localIndices[local * 3 + 2] * 2;
      nextArea += Math.abs(signedTriangleArea2D(
        next[a], next[a + 1],
        next[b], next[b + 1],
        next[c], next[c + 1],
      ));
    }
    let currentArea = 0;
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const a = chart.localIndices[local * 3] * 2;
      const b = chart.localIndices[local * 3 + 1] * 2;
      const c = chart.localIndices[local * 3 + 2] * 2;
      currentArea += Math.abs(signedTriangleArea2D(
        uvs[a], uvs[a + 1],
        uvs[b], uvs[b + 1],
        uvs[c], uvs[c + 1],
      ));
    }
    if (!(nextArea > EPSILON) || !(currentArea > EPSILON)) break;
    const areaScale = Math.sqrt(currentArea / nextArea);
    if (Math.abs(areaScale - 1) > 1e-6) {
      const centerU = (chart.bbox.minU + chart.bbox.maxU) / 2;
      const centerV = (chart.bbox.minV + chart.bbox.maxV) / 2;
      for (let vertex = 0; vertex < count; vertex += 1) {
        next[vertex * 2] = centerU + (next[vertex * 2] - centerU) * areaScale;
        next[vertex * 2 + 1] = centerV + (next[vertex * 2 + 1] - centerV) * areaScale;
      }
    }
    const nextScore = uvAngleScore(next);
    if (!(nextScore < angleAfter - 1e-6)) break;
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
    if (!valid) break;
    uvs = next;
    angleAfter = nextScore;
    smoothingPasses += 1;
  }
  const finalDensities = chartFaceDensities(chart, face, resolution, uvs);
  const differenceAfter = densityDifference(finalDensities, reference);
  return { uvs, iterations, passes, smoothingPasses, angleBefore, angleAfter, maxFactor, attempted, history, differenceBefore, differenceAfter };
}

/** Inflation-only density pass. It runs after chart normalization and never
 * shrinks a chart; it scales low-density triangles around their centers until
 * they approach the average density or no safe scale remains. */
export function relaxDensity(
  mesh: ConditionedMesh,
  normalized: DensityResult,
  face: FaceGeometry,
  options: RelaxOptions,
): DensityResult {
  const resolution = Math.max(1, Math.round(options.atlasResolution));
  const target = Math.max(0, options.targetTexelDensity);
  const maxExpansion = options.maxExpansion ?? 16;
  const maxIterations = Math.max(1, Math.round(options.maxIterations ?? 1000));
  const issues: Issue[] = [];
  if (options.atlasResolution <= 0 || options.targetTexelDensity <= 0) {
    issues.push({
      stage: 'relax',
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
  let boidPasses = 0;
  let inflationIterations = 0;
  const relaxHistory: RelaxPassSample[] = [];
  let smoothingPasses = 0;
  let angleBefore = 0;
  let angleAfter = 0;
  let angleCharts = 0;
  let maxInflationApplied = 1;
  for (const chart of charts) {
    const inflated = relaxChart(mesh, chart, face, resolution, referenceDensity, maxExpansion, maxIterations);
    if (inflated.attempted) attemptedCharts += 1;
    if (inflated.passes > 0) {
      boidPasses += inflated.passes;
      relaxHistory.push(...inflated.history);
    }
    if (inflated.smoothingPasses > 0) {
      angleBefore += inflated.angleBefore;
      angleAfter += inflated.angleAfter;
      angleCharts += 1;
      smoothingPasses = Math.max(smoothingPasses, inflated.smoothingPasses);
    }
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
      stage: 'relax',
      severity: 'info',
      code: 'density-relaxed',
      message: `Relaxed ${inflatedCharts} of ${charts.length} chart${charts.length === 1 ? '' : 's'} in ${boidPasses} boid passes.`,
      value: inflatedCharts,
    });
    if (averageDensity > 0 && minimumAfter < averageDensity * 0.995) {
      issues.push({
        stage: 'relax',
        severity: 'info',
        code: 'density-relax-limited',
        message: `Stopped at ${minimumAfter.toFixed(1)} px/unit; the lowest face is still below the ${averageDensity.toFixed(1)} px/unit average.`,
        value: Number(minimumAfter.toFixed(4)),
        threshold: Number(averageDensity.toFixed(4)),
      });
    }
  } else if (attemptedCharts > 0) {
    issues.push({
      stage: 'relax',
      severity: 'info',
      code: 'density-relax-blocked',
      message: `No chart could grow without lowering another face; ${attemptedCharts} chart${attemptedCharts === 1 ? '' : 's'} still have low-density faces.`,
      value: attemptedCharts,
    });
  } else {
    issues.push({
      stage: 'relax',
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
    densityDifferenceBefore: Number(densityDifference(densitiesBefore, referenceDensity).toFixed(8)),
    densityDifferenceAfter: Number(densityDifference(densitiesAfter, referenceDensity).toFixed(8)),
    densityP50: Number(arrays.summary.p50.toFixed(4)),
    densityP95: Number(arrays.summary.p95.toFixed(4)),
    attemptedCharts,
    relaxedCharts: inflatedCharts,
    relaxedFaces: inflatedFaces,
    relaxedVertices: inflatedVertices,
    boidPasses,
    expandedTriangles: inflationIterations,
    smoothingPasses,
    angleMeanBefore: Number((angleCharts > 0 ? angleBefore / angleCharts : 0).toFixed(4)),
    angleMeanAfter: Number((angleCharts > 0 ? angleAfter / angleCharts : 0).toFixed(4)),
    maxExpansion: Number(maxInflationApplied.toFixed(4)),
    uvAreaFraction: Number(uvAreaFraction.toFixed(6)),
  };

  return {
    charts,
    triangleUvs: arrays.triangleUvs,
    faceTexelDensity: arrays.faceTexelDensity,
    densityRatio: arrays.densityRatio,
    chartScales: normalized.chartScales,
    stats,
    relaxHistory,
    issues,
  };
}
