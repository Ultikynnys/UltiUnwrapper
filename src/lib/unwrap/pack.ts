import type { FaceGeometry } from './mesh';
import { signedTriangleArea2D, summarize } from './metrics';
import { rasterizeCoverage, type RasterTriangle } from './raster';
import type {
  ChartPlacement,
  ChartUv,
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
  fitIterations?: number;
  occupancyResolution?: number;
  minOccupancy?: number;
};

type Rect = { x: number; y: number; w: number; h: number };
type Item = { chart: number; baseW: number; baseH: number };
type Placement = { chart: number; x: number; y: number; w: number; h: number; rotation: 0 | 90 };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function contains(a: Rect, b: Rect): boolean {
  return a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
}

function prune(rects: Rect[]): Rect[] {
  const result: Rect[] = [];
  for (let i = 0; i < rects.length; i += 1) {
    let keep = true;
    for (let j = 0; j < rects.length; j += 1) {
      if (i === j) continue;
      if (contains(rects[j], rects[i])) {
        keep = false;
        break;
      }
    }
    if (keep && rects[i].w > 0 && rects[i].h > 0) result.push(rects[i]);
  }
  return result;
}

function splitFree(free: Rect[], used: Rect): Rect[] {
  const next: Rect[] = [];
  for (const rect of free) {
    if (!overlaps(rect, used)) {
      next.push(rect);
      continue;
    }
    if (used.y > rect.y) {
      next.push({ x: rect.x, y: rect.y, w: rect.w, h: used.y - rect.y });
    }
    if (used.y + used.h < rect.y + rect.h) {
      next.push({
        x: rect.x,
        y: used.y + used.h,
        w: rect.w,
        h: rect.y + rect.h - (used.y + used.h),
      });
    }
    if (used.x > rect.x) {
      next.push({ x: rect.x, y: rect.y, w: used.x - rect.x, h: rect.h });
    }
    if (used.x + used.w < rect.x + rect.w) {
      next.push({
        x: used.x + used.w,
        y: rect.y,
        w: rect.x + rect.w - (used.x + used.w),
        h: rect.h,
      });
    }
  }
  return prune(next);
}

function packRectangles(items: Item[], resolution: number, padding: number, allowRotation: boolean): Placement[] | null {
  const free: Rect[] = [{ x: 0, y: 0, w: resolution, h: resolution }];
  const sorted = [...items].sort((a, b) => {
    const areaA = a.baseW * a.baseH;
    const areaB = b.baseW * b.baseH;
    if (areaB !== areaA) return areaB - areaA;
    const sideA = Math.max(a.baseW, a.baseH);
    const sideB = Math.max(b.baseW, b.baseH);
    if (sideB !== sideA) return sideB - sideA;
    return a.chart - b.chart;
  });
  const placements: Placement[] = [];

  for (const item of sorted) {
    let best: {
      x: number; y: number; w: number; h: number; rotation: 0 | 90;
      shortSide: number; longSide: number;
    } | null = null;
    for (const rect of free) {
      const candidates: Array<{ w: number; h: number; rotation: 0 | 90 }> = [
        { w: Math.ceil(item.baseW) + padding * 2, h: Math.ceil(item.baseH) + padding * 2, rotation: 0 },
      ];
      if (allowRotation) {
        candidates.push({
          w: Math.ceil(item.baseH) + padding * 2,
          h: Math.ceil(item.baseW) + padding * 2,
          rotation: 90,
        });
      }
      for (const candidate of candidates) {
        if (candidate.w > rect.w || candidate.h > rect.h) continue;
        const shortSide = Math.min(rect.w - candidate.w, rect.h - candidate.h);
        const longSide = Math.max(rect.w - candidate.w, rect.h - candidate.h);
        const better = best === null
          || shortSide < best.shortSide
          || (shortSide === best.shortSide && longSide < best.longSide)
          || (shortSide === best.shortSide && longSide === best.longSide && rect.y < best.y)
          || (shortSide === best.shortSide && longSide === best.longSide && rect.y === best.y && rect.x < best.x);
        if (better) {
          best = {
            x: rect.x,
            y: rect.y,
            w: candidate.w,
            h: candidate.h,
            rotation: candidate.rotation,
            shortSide,
            longSide,
          };
        }
      }
    }
    if (!best) return null;
    const placed: Placement = {
      chart: item.chart,
      x: best.x,
      y: best.y,
      w: best.w,
      h: best.h,
      rotation: best.rotation,
    };
    placements.push(placed);
    const used: Rect = { x: placed.x, y: placed.y, w: placed.w, h: placed.h };
    const nextFree = splitFree(free, used);
    free.length = 0;
    free.push(...nextFree);
  }
  return placements;
}

type Attempt = {
  scale: number;
  placements: Placement[];
  bboxOccupancy: number;
};

function attemptPack(
  charts: ChartUv[],
  resolution: number,
  padding: number,
  allowRotation: boolean,
  scale: number,
): Attempt | null {
  const items: Item[] = charts.map((chart) => ({
    chart: chart.chart,
    baseW: Math.max(1, (chart.bbox.maxU - chart.bbox.minU) * resolution * scale),
    baseH: Math.max(1, (chart.bbox.maxV - chart.bbox.minV) * resolution * scale),
  }));
  const placements = packRectangles(items, resolution, padding, allowRotation);
  if (!placements) return null;
  let bboxArea = 0;
  for (const placement of placements) {
    const innerW = Math.max(0, placement.w - padding * 2);
    const innerH = Math.max(0, placement.h - padding * 2);
    bboxArea += innerW * innerH;
  }
  return { scale, placements, bboxOccupancy: bboxArea / (resolution * resolution) };
}

/** Packs normalized-density charts with MaxRects. If the target density does
 * not fit, every chart is scaled by the same factor, so relative texel density
 * stays uniform and the achieved density is target * scale. */
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
  const emptyTriangleUvs = new Float32Array(mesh.triangleCount * 6);
  const emptyDensity = new Float32Array(mesh.triangleCount);

  if (padding * 2 >= resolution) {
    issues.push({
      stage: 'pack',
      severity: 'error',
      code: 'padding-exceeds-atlas',
      message: 'Packing padding leaves no room inside the atlas.',
    });
    return {
      charts: [],
      triangleUvs: emptyTriangleUvs,
      placements: [],
      scale: 0,
      achievedTexelDensity: 0,
      faceTexelDensity: emptyDensity,
      occupancy: 0,
      bboxOccupancy: 0,
      stats: { atlasResolution: resolution, padding, charts: 0 },
      issues,
    };
  }

  let best = attemptPack(density.charts, resolution, padding, options.allowRotation, 1);
  let bestScale = 1;
  if (!best) {
    const minimumScale = 1e-4;
    let low = minimumScale;
    let high = 1;
    const iterations = options.fitIterations ?? 18;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const mid = (low + high) / 2;
      const attempt = attemptPack(density.charts, resolution, padding, options.allowRotation, mid);
      if (attempt) {
        best = attempt;
        bestScale = mid;
        low = mid;
      } else {
        high = mid;
      }
    }
    if (!best) {
      issues.push({
        stage: 'pack',
        severity: 'error',
        code: 'atlas-overflow',
        message: `The charts do not fit in a ${resolution} px atlas with ${padding} px padding, even after scaling.`,
        value: Number(bestScale.toFixed(6)),
      });
      return {
        charts: [],
        triangleUvs: emptyTriangleUvs,
        placements: [],
        scale: 0,
        achievedTexelDensity: 0,
        faceTexelDensity: emptyDensity,
        occupancy: 0,
        bboxOccupancy: 0,
        stats: { atlasResolution: resolution, padding, charts: density.charts.length },
        issues,
      };
    }
  }
  bestScale = best.scale;
  const placements: ChartPlacement[] = best.placements.map((placement) => {
    const innerWidth = Math.max(1, placement.w - padding * 2);
    const innerHeight = Math.max(1, placement.h - padding * 2);
    return {
      chart: placement.chart,
      x: placement.x + padding,
      y: placement.y + padding,
      width: innerWidth,
      height: innerHeight,
      rotation: placement.rotation,
    };
  });

  const packedByChart = new Map<number, Placement>();
  for (const placement of best.placements) packedByChart.set(placement.chart, placement);
  const innerByChart = new Map<number, ChartPlacement>();
  for (const placement of placements) innerByChart.set(placement.chart, placement);
  const charts: PackedChart[] = [];
  const triangleUvs = new Float32Array(mesh.triangleCount * 6);

  for (const chart of density.charts) {
    const placement = innerByChart.get(chart.chart);
    const outer = packedByChart.get(chart.chart);
    if (!placement || !outer) continue;
    const innerX = placement.x;
    const innerY = placement.y;
    const baseWidth = chart.bbox.maxU - chart.bbox.minU;
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
      code: 'density-reduced',
      message: `Atlas fit reduced texel density to ${achievedTexelDensity.toFixed(1)} px/unit.`,
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
  if (options.allowRotation && placements.some((placement) => placement.rotation === 90)) {
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
    bboxOccupancy: Number(best.bboxOccupancy.toFixed(6)),
    rotatedCharts: placements.filter((placement) => placement.rotation === 90).length,
  };

  return {
    charts,
    triangleUvs,
    placements,
    scale: bestScale,
    achievedTexelDensity,
    faceTexelDensity,
    occupancy,
    bboxOccupancy: best.bboxOccupancy,
    stats,
    issues,
  };
}
