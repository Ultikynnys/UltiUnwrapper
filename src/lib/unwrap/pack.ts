import { alignChartsToAxes } from './chartAlign';
import { packConcaveCharts } from './concavePack';
import type { FaceGeometry } from './mesh';
import { signedTriangleArea2D, summarize } from './metrics';
import { rasterizeCoverage, type RasterTriangle } from './raster';
import type {
  ChartPlacement,
  ConditionedMesh,
  DensityResult,
  Issue,
  PackedChart,
  PackResult,
  StageStats,
} from './types';

export type { PackResult } from './types';

export const PACK_SEARCH_GRID = 512;
export const PACK_SPARSE_FILL = 0.45;
export const PACK_MANY_CHARTS = 12;
const PACK_FILL_FACTORS = [1.25, 1.5, 1.75, 2] as const;
const PACK_FILL_MIN_SCALE = 0.999;
const PACK_FILL_MAX_SCALE = 1.02;

export type PackOptions = {
  atlasResolution: number;
  padding: number;
  allowRotation: boolean;
  targetTexelDensity: number;
  occupancyResolution?: number;
  minOccupancy?: number;
  /** Grow every chart uniformly until the atlas is full, instead of holding
   * the requested target density. */
  fitToAtlas?: boolean;
  /** Rotate each chart to its smallest axis-aligned bounding box before
   * rasterizing. Enabled by default. */
  alignCharts?: boolean;
};

/** Packs chart silhouettes with the concave packer. Throws if the charts
 * cannot be placed at full target density. */
export function packAtlas(
  mesh: ConditionedMesh,
  density: DensityResult,
  face: FaceGeometry,
  options: PackOptions,
): PackResult {
  const resolution = Math.max(1, Math.round(options.atlasResolution));
  const padding = Math.max(0, Math.round(options.padding));
  const target = Math.max(0, options.targetTexelDensity);
  const issues: Issue[] = [];

  if (padding * 2 >= resolution) {
    throw new Error(
      `Packing padding of ${padding} px on each side leaves no room inside the ${resolution} px atlas.`,
    );
  }

  const alignment = options.alignCharts === false ? null : alignChartsToAxes(density.charts);
  const sourceCharts = alignment?.charts ?? density.charts;
  let requiredArea = 0;
  for (const chart of sourceCharts) requiredArea += chart.uvArea;
  const fitToAtlas = Boolean(options.fitToAtlas);
  const grid = Math.min(1024, resolution);
  const searchGrid = Math.min(PACK_SEARCH_GRID, grid);
  const attempt = (scale: number, fill: boolean, workingGrid = grid) => packConcaveCharts(sourceCharts, {
    grid: workingGrid,
    resolution,
    padding,
    allowRotation: options.allowRotation,
    scale,
    fill,
  });
  let best = attempt(1, fitToAtlas);
  if (!best && fitToAtlas) {
    let low = 0;
    let high = 1;
    const areaLimit = requiredArea > 0 ? Math.sqrt(1 / requiredArea) : 1;
    let scale = Math.min(0.9, areaLimit * 1.1);
    for (let step = 0; step < 6 && scale > 0.02; step += 1) {
      const trial = attempt(scale, false, searchGrid);
      if (trial) {
        low = scale;
        break;
      }
      high = scale;
      scale *= 0.75;
    }
    // Narrow the feasible range before filling, so a layout that misses at
    // full density is not pushed all the way down to a coarse 0.75 step.
    for (let step = 0; step < 2 && low > 0 && high - low > 0.02; step += 1) {
      const middle = (low + high) / 2;
      if (attempt(middle, false, searchGrid)) low = middle;
      else high = middle;
    }
    if (low > 0) {
      const coarse = attempt(low, true, searchGrid) ?? attempt(low, false, searchGrid);
      best = attempt(low, true) ?? attempt(low, false) ?? coarse;
    }
  }
  const sparseFill = best ? best.usedArea / (grid * grid) < PACK_SPARSE_FILL : false;
  const manySmallCharts = requiredArea < PACK_SPARSE_FILL
    && sourceCharts.length >= PACK_MANY_CHARTS;
  if (best && fitToAtlas && best.scale >= PACK_FILL_MIN_SCALE
    && (sparseFill || manySmallCharts)
    && (best.scale <= PACK_FILL_MAX_SCALE || requiredArea < PACK_SPARSE_FILL)) {
    // packConcaveCharts fills the placed layout, but a sparse first-fit
    // arrangement can hit the atlas width before the atlas height is used.
    // Repacking with larger input scales finds a fuller arrangement.
    let fillScale = best.scale;
    for (const factor of PACK_FILL_FACTORS) {
      const trial = attempt(factor, true);
      if (!trial) break;
      if (trial.scale > fillScale + 1e-6) {
        best = trial;
        fillScale = trial.scale;
      }
    }
  }
  if (!best) {
    const hint = requiredArea > 1
      ? ' Lower targetTexelDensity or raise atlasResolution.'
      : '';
    throw new Error(
      `Concave packing could not place ${sourceCharts.length} charts in a ${resolution} px atlas with ${padding} px padding. The charts cover ${(requiredArea * 100).toFixed(1)}% of the atlas at the target density.${hint}`,
    );
  }
  if (best.placements.length !== sourceCharts.length) {
    throw new Error(
      `Concave packing placed ${best.placements.length} of ${sourceCharts.length} charts.`,
    );
  }
  const bestScale = best.scale;
  const placements: ChartPlacement[] = best.placements.map((placement) => ({
    chart: placement.chart,
    x: placement.x,
    y: placement.y,
    width: Math.max(1, placement.width),
    height: Math.max(1, placement.height),
    rotation: placement.rotation,
  }));
  const innerByChart = new Map<number, ChartPlacement>();
  for (const placement of placements) innerByChart.set(placement.chart, placement);
  const charts: PackedChart[] = [];
  const triangleUvs = new Float32Array(mesh.triangleCount * 6);

  for (const chart of sourceCharts) {
    const placement = innerByChart.get(chart.chart);
    if (!placement) continue;
    const innerX = placement.x;
    const innerY = placement.y;
    const baseWidth = chart.bbox.maxU - chart.bbox.minU;
    const baseHeight = chart.bbox.maxV - chart.bbox.minV;
    const uvs = new Float32Array(chart.uvs.length);
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (let vertex = 0; vertex < chart.uvs.length / 2; vertex += 1) {
      const localU = chart.uvs[vertex * 2] - chart.bbox.minU;
      const localV = chart.uvs[vertex * 2 + 1] - chart.bbox.minV;
      let atlasU: number;
      let atlasV: number;
      if (placement.rotation === 90) {
        atlasU = (innerX + localV * resolution * bestScale) / resolution;
        atlasV = (innerY + (baseWidth - localU) * resolution * bestScale) / resolution;
      } else if (placement.rotation === 180) {
        atlasU = (innerX + (baseWidth - localU) * resolution * bestScale) / resolution;
        atlasV = (innerY + (baseHeight - localV) * resolution * bestScale) / resolution;
      } else if (placement.rotation === 270) {
        atlasU = (innerX + (baseHeight - localV) * resolution * bestScale) / resolution;
        atlasV = (innerY + localU * resolution * bestScale) / resolution;
      } else {
        atlasU = (innerX + localU * resolution * bestScale) / resolution;
        atlasV = (innerY + localV * resolution * bestScale) / resolution;
      }
      uvs[vertex * 2] = Math.min(1, Math.max(0, atlasU));
      uvs[vertex * 2 + 1] = Math.min(1, Math.max(0, atlasV));
      minU = Math.min(minU, uvs[vertex * 2]);
      minV = Math.min(minV, uvs[vertex * 2 + 1]);
      maxU = Math.max(maxU, uvs[vertex * 2]);
      maxV = Math.max(maxV, uvs[vertex * 2 + 1]);
    }
    const packed: PackedChart = {
      ...chart,
      uvs,
      uvArea: chart.uvArea * bestScale * bestScale,
      bbox: { minU, minV, maxU, maxV },
      placement,
    };
    charts.push(packed);
    for (let local = 0; local < packed.triangles.length; local += 1) {
      const triangle = packed.triangles[local];
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = packed.localIndices[local * 3 + corner];
        triangleUvs[triangle * 6 + corner * 2] = packed.uvs[vertex * 2];
        triangleUvs[triangle * 6 + corner * 2 + 1] = packed.uvs[vertex * 2 + 1];
      }
    }
  }

  const faceTexelDensity = new Float32Array(mesh.triangleCount);
  for (const chart of charts) {
    for (let local = 0; local < chart.triangles.length; local += 1) {
      const triangle = chart.triangles[local];
      const a = chart.localIndices[local * 3];
      const b = chart.localIndices[local * 3 + 1];
      const c = chart.localIndices[local * 3 + 2];
      const uvArea = Math.abs(signedTriangleArea2D(
        chart.uvs[a * 2], chart.uvs[a * 2 + 1],
        chart.uvs[b * 2], chart.uvs[b * 2 + 1],
        chart.uvs[c * 2], chart.uvs[c * 2 + 1],
      ));
      const worldArea = face.areas[triangle];
      faceTexelDensity[triangle] = uvArea > 1e-12 && worldArea > 1e-12
        ? Math.sqrt((uvArea * resolution * resolution) / worldArea)
        : 0;
    }
  }

  const rasterTriangles: RasterTriangle[] = [];
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    const offset = triangle * 6;
    rasterTriangles.push({
      uv: [
        [triangleUvs[offset], triangleUvs[offset + 1]],
        [triangleUvs[offset + 2], triangleUvs[offset + 3]],
        [triangleUvs[offset + 4], triangleUvs[offset + 5]],
      ],
    });
  }
  const occupancyResolution = Math.min(
    resolution,
    Math.max(1, Math.round(options.occupancyResolution ?? 1024)),
  );
  const coverage = rasterizeCoverage(occupancyResolution, occupancyResolution, rasterTriangles);
  const occupancy = coverage.covered / (occupancyResolution * occupancyResolution);
  const achievedTexelDensity = target * bestScale;

  if (bestScale < 0.999) {
    issues.push({
      stage: 'pack',
      severity: 'warn',
      code: 'density-fitted',
      message: `Atlas fit scaled every chart to ${achievedTexelDensity.toFixed(1)} px/unit (scale ${bestScale.toFixed(3)}).`,
      value: Number(bestScale.toFixed(6)),
    });
  } else if (bestScale > 1.001) {
    issues.push({
      stage: 'pack',
      severity: 'info',
      code: 'density-increased',
      message: `Atlas fill increased texel density to ${achievedTexelDensity.toFixed(1)} px/unit.`,
      value: Number(bestScale.toFixed(6)),
    });
  }
  const minOccupancy = options.minOccupancy ?? 0.3;
  if (charts.length > 1 && occupancy < minOccupancy) {
    issues.push({
      stage: 'pack',
      severity: 'warn',
      code: 'low-occupancy',
      message: `Atlas occupancy is ${(occupancy * 100).toFixed(1)}%.`,
      value: Number(occupancy.toFixed(6)),
      threshold: minOccupancy,
    });
  }
  if (options.allowRotation && placements.some((placement) => placement.rotation !== 0)) {
    issues.push({
      stage: 'pack',
      severity: 'info',
      code: 'rotated-charts',
      message: 'Some charts were rotated 90 degrees to improve the fit.',
    });
  }

  const densitySummary = summarize(faceTexelDensity);
  const stats: StageStats = {
    charts: charts.length,
    atlasResolution: resolution,
    padding,
    scale: Number(bestScale.toFixed(6)),
    targetDensity: target,
    achievedDensity: Number(achievedTexelDensity.toFixed(4)),
    densityP50: Number(densitySummary.p50.toFixed(4)),
    occupancy: Number(occupancy.toFixed(6)),
    rotatedCharts: placements.filter((placement) => placement.rotation !== 0).length,
    axisAlignedCharts: alignment?.rotated ?? 0,
    bboxAreaBefore: Number((alignment?.areaBefore ?? 0).toFixed(6)),
    bboxAreaAfter: Number((alignment?.areaAfter ?? 0).toFixed(6)),
  };

  return {
    charts,
    triangleUvs,
    placements,
    scale: bestScale,
    achievedTexelDensity,
    faceTexelDensity,
    occupancy,
    stats,
    issues,
  };
}
