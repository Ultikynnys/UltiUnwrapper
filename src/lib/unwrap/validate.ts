import { summarize } from './metrics';
import { rasterizeTriangles, type RasterTriangle } from './raster';
import type {
  ChartUv,
  ConditionedMesh,
  Issue,
  PackedChart,
  PackResult,
  ParameterizeResult,
  StageStats,
  Weakness,
} from './types';
import type { ValidationThresholds as Thresholds } from './config';

export type { Weakness, WeaknessKind } from './types';

export type ValidationStatus = 'pass' | 'warn' | 'error';

export type ValidationResult = {
  status: ValidationStatus;
  stats: StageStats;
  issues: Issue[];
  weaknesses: Weakness[];
  topWeaknesses: Weakness[];
  /** 1 for a triangle sharing at least one texel with another triangle. */
  faceOverlap: Uint8Array;
  /** Per-texel coverage counts, saturated at 2, at validation resolution. */
  overlapMask: Uint8Array;
  overlapWidth: number;
  overlapHeight: number;
};

export type ValidationOptions = Thresholds & {
  occupancyResolution: number;
};

const EPSILON = 1e-12;

function valuesSpread(values: ArrayLike<number>): number {
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!(value > EPSILON)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || min <= 0) return 0;
  return max / min - 1;
}

function chartValues(
  chart: ChartUv,
  values: Float32Array,
): number[] {
  const result: number[] = [];
  for (let local = 0; local < chart.triangles.length; local += 1) {
    result.push(values[chart.triangles[local]]);
  }
  return result;
}

/** Validates the final atlas: coverage overlap, distortion percentiles, density
 * spread, flips, and a ranked chart-level weakness list. Thresholds come from
 * the same config used by the CLI `--check` gate. */
export function validateUnwrap(
  mesh: ConditionedMesh,
  parameterization: ParameterizeResult,
  pack: PackResult,
  options: ValidationOptions,
): ValidationResult {
  const atlasResolution = typeof pack.stats.atlasResolution === 'number'
    ? pack.stats.atlasResolution
    : 2048;
  const resolution = Math.min(
    2048,
    Math.max(64, Math.round(options.occupancyResolution || 2048)),
    Math.max(1, Math.round(atlasResolution)),
  );
  const counts = new Uint8Array(resolution * resolution);
  const firstTriangle = new Int32Array(resolution * resolution).fill(-1);
  const faceOverlap = new Uint8Array(mesh.triangleCount);
  let covered = 0;
  let overlapping = 0;

  const triangles: RasterTriangle[] = [];
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    const offset = triangle * 6;
    triangles.push({
      uv: [
        [pack.triangleUvs[offset], pack.triangleUvs[offset + 1]],
        [pack.triangleUvs[offset + 2], pack.triangleUvs[offset + 3]],
        [pack.triangleUvs[offset + 4], pack.triangleUvs[offset + 5]],
      ],
    });
  }
  rasterizeTriangles(resolution, resolution, triangles, (px, py, _w0, _w1, _w2, triangle) => {
    const index = py * resolution + px;
    if (counts[index] === 0) {
      counts[index] = 1;
      firstTriangle[index] = triangle;
      covered += 1;
    } else if (counts[index] === 1) {
      counts[index] = 2;
      overlapping += 1;
      const first = firstTriangle[index];
      if (first >= 0) faceOverlap[first] = 1;
      faceOverlap[triangle] = 1;
    } else {
      faceOverlap[triangle] = 1;
    }
  }, { interior: true });

  const overlapFraction = covered > 0 ? overlapping / covered : 0;
  const angleSummary = summarize(parameterization.angleDistortion);
  const areaSummary = summarize(parameterization.areaDistortion);
  let flipped = 0;
  for (const value of parameterization.flipped) flipped += value;
  const densitySpread = valuesSpread(pack.faceTexelDensity);
  const densitySummary = summarize(pack.faceTexelDensity);
  const achievedDensity = pack.achievedTexelDensity;
  const chartMap = new Map<number, PackedChart>();
  for (const chart of pack.charts) chartMap.set(chart.chart, chart);

  const weaknesses: Weakness[] = [];
  for (const chart of parameterization.charts) {
    const packed = chartMap.get(chart.chart);
    if (!packed) continue;
    const angles = chartValues(chart, parameterization.angleDistortion);
    const areas = chartValues(chart, parameterization.areaDistortion);
    const angleP95 = summarize(angles).p95;
    const areaP95 = summarize(areas).p95;
    let chartFlipped = 0;
    let chartOverlapFaces = 0;
    let densityError = 0;
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const triangle = chart.triangles[local];
      if (parameterization.flipped[triangle]) chartFlipped += 1;
      if (faceOverlap[triangle]) chartOverlapFaces += 1;
      if (achievedDensity > EPSILON) {
        densityError = Math.max(densityError, Math.abs(pack.faceTexelDensity[triangle] / achievedDensity - 1));
      }
    }
    const normalized = [
      options.maxAngleP95 > 0 ? angleP95 / options.maxAngleP95 : 0,
      options.maxDensitySpread > 0 ? densityError / options.maxDensitySpread : 0,
      chartOverlapFaces > 0 ? 1 : 0,
      chartFlipped > 0 ? 1 : 0,
      areaP95 > 1.5 ? areaP95 / 1.5 : 0,
    ];
    const score = Math.max(...normalized);
    if (angleP95 > options.maxAngleP95) {
      weaknesses.push({
        chart: chart.chart,
        kind: 'angle',
        value: Number(angleP95.toFixed(4)),
        threshold: options.maxAngleP95,
        severity: 'error',
        message: `Chart ${chart.chart} angle distortion p95 is ${angleP95.toFixed(2)} degrees.`,
        score,
      });
    }
    if (densityError > options.maxDensitySpread) {
      weaknesses.push({
        chart: chart.chart,
        kind: 'density',
        value: Number(densityError.toFixed(4)),
        threshold: options.maxDensitySpread,
        severity: 'error',
        message: `Chart ${chart.chart} density error is ${(densityError * 100).toFixed(1)}%.`,
        score,
      });
    }
    if (chartOverlapFaces > 0) {
      weaknesses.push({
        chart: chart.chart,
        kind: 'overlap',
        value: chartOverlapFaces,
        threshold: 0,
        severity: 'error',
        message: `Chart ${chart.chart} has ${chartOverlapFaces} overlapping face${chartOverlapFaces === 1 ? '' : 's'}.`,
        score,
      });
    }
    if (chartFlipped > 0) {
      weaknesses.push({
        chart: chart.chart,
        kind: 'flipped',
        value: chartFlipped,
        threshold: 0,
        severity: 'error',
        message: `Chart ${chart.chart} has ${chartFlipped} flipped triangle${chartFlipped === 1 ? '' : 's'}.`,
        score,
      });
    }
    if (areaP95 > 1.5) {
      weaknesses.push({
        chart: chart.chart,
        kind: 'area',
        value: Number(areaP95.toFixed(4)),
        threshold: 1.5,
        severity: 'warn',
        message: `Chart ${chart.chart} area distortion p95 is ${areaP95.toFixed(2)} octaves.`,
        score,
      });
    }
  }
  weaknesses.sort((a, b) => b.score - a.score || a.chart - b.chart || a.kind.localeCompare(b.kind));
  const topWeaknesses = weaknesses.slice(0, 20);

  const occupancy = Number(pack.stats.occupancy);
  const failed = overlapFraction > options.maxOverlapFraction
    || angleSummary.p95 > options.maxAngleP95
    || densitySpread > options.maxDensitySpread
    || flipped > options.maxFlipped
    || covered === 0;
  const hasErrorWeakness = weaknesses.some((weakness) => weakness.severity === 'error');
  const issues: Issue[] = [];
  if (covered === 0) {
    issues.push({
      stage: 'validate',
      severity: 'error',
      code: 'no-coverage',
      message: 'The final atlas has no covered texels.',
    });
  }
  if (overlapFraction > options.maxOverlapFraction) {
    issues.push({
      stage: 'validate',
      severity: 'error',
      code: 'overlap-above-threshold',
      message: `Overlap covers ${(overlapFraction * 100).toFixed(3)}% of used texels.`,
      value: Number(overlapFraction.toFixed(6)),
      threshold: options.maxOverlapFraction,
    });
  }
  if (angleSummary.p95 > options.maxAngleP95) {
    issues.push({
      stage: 'validate',
      severity: 'error',
      code: 'angle-p95-above-threshold',
      message: `Angle distortion p95 is ${angleSummary.p95.toFixed(2)} degrees.`,
      value: Number(angleSummary.p95.toFixed(4)),
      threshold: options.maxAngleP95,
    });
  }
  if (densitySpread > options.maxDensitySpread) {
    issues.push({
      stage: 'validate',
      severity: 'error',
      code: 'density-spread-above-threshold',
      message: `Texel density varies by ${(densitySpread * 100).toFixed(1)}%.`,
      value: Number(densitySpread.toFixed(6)),
      threshold: options.maxDensitySpread,
    });
  }
  if (flipped > options.maxFlipped) {
    issues.push({
      stage: 'validate',
      severity: 'error',
      code: 'flipped-above-threshold',
      message: `${flipped} flipped triangle${flipped === 1 ? '' : 's'}.`,
      value: flipped,
      threshold: options.maxFlipped,
    });
  }
  if (Number.isFinite(occupancy) && occupancy < options.minOccupancy) {
    issues.push({
      stage: 'validate',
      severity: 'warn',
      code: 'low-occupancy',
      message: `Atlas occupancy is ${(occupancy * 100).toFixed(1)}%.`,
      value: occupancy,
      threshold: options.minOccupancy,
    });
  }
  if (topWeaknesses.length > 0 && !failed && !hasErrorWeakness) {
    issues.push({
      stage: 'validate',
      severity: 'warn',
      code: 'weak-charts',
      message: `${topWeaknesses.length} chart weakness${topWeaknesses.length === 1 ? '' : 'es'} found.`,
      value: topWeaknesses.length,
    });
  }
  const status: ValidationStatus = failed || hasErrorWeakness
    ? 'error'
    : issues.length > 0
      ? 'warn'
      : 'pass';

  const stats: StageStats = {
    status,
    charts: parameterization.charts.length,
    overlapFraction: Number(overlapFraction.toFixed(8)),
    overlapTexels: overlapping,
    coveredTexels: covered,
    validationResolution: resolution,
    angleP50: Number(angleSummary.p50.toFixed(4)),
    angleP95: Number(angleSummary.p95.toFixed(4)),
    angleMax: Number(angleSummary.max.toFixed(4)),
    areaP50: Number(areaSummary.p50.toFixed(4)),
    areaP95: Number(areaSummary.p95.toFixed(4)),
    flipped,
    densitySpread: Number(densitySpread.toFixed(6)),
    densityP50: Number(densitySummary.p50.toFixed(4)),
    targetDensity: pack.stats.targetDensity as number,
    achievedDensity: Number(achievedDensity.toFixed(4)),
    occupancy: Number(occupancy.toFixed(6)),
    weaknessCount: topWeaknesses.length,
  };

  return {
    status,
    stats,
    issues,
    weaknesses,
    topWeaknesses,
    faceOverlap,
    overlapMask: counts,
    overlapWidth: resolution,
    overlapHeight: resolution,
  };
}
