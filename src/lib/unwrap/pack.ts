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

  const fitToAtlas = Boolean(options.fitToAtlas);
  const grid = Math.min(1024, resolution);
  const best = packConcaveCharts(density.charts, {
    grid,
    resolution,
    padding,
    allowRotation: options.allowRotation,
    scale: 1,
    fill: fitToAtlas,
  });
  if (!best) {
    let requiredArea = 0;
    for (const chart of density.charts) requiredArea += chart.uvArea;
    const hint = requiredArea > 1
      ? ' Lower targetTexelDensity or raise atlasResolution.'
      : '';
    throw new Error(
      `Concave packing could not place ${density.charts.length} charts in a ${resolution} px atlas with ${padding} px padding. The charts cover ${(requiredArea * 100).toFixed(1)}% of the atlas at the target density.${hint}`,
    );
  }
  if (best.placements.length !== density.charts.length) {
    throw new Error(
      `Concave packing placed ${best.placements.length} of ${density.charts.length} charts.`,
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

  for (const chart of density.charts) {
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

  if (bestScale > 1.001) {
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
