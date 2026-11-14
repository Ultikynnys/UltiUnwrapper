import { packConcaveCharts, type ConcavePlacement } from './concavePack';
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
  /** Grow every chart uniformly until the atlas is full, instead of holding
   * the requested target density. */
  fitToAtlas?: boolean;
};

type Rect = { x: number; y: number; w: number; h: number };
type Item = { chart: number; baseW: number; baseH: number };
type Placement = {
  chart: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: 0 | 90 | 180 | 270;
  /** Concave placements already carry inner content bounds. */
  inner?: boolean;
};

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

type Heuristic = 'bssf' | 'blsf' | 'baf' | 'bl';

type SortMode = {
  name: string;
  compare: (a: Item, b: Item) => number;
};

function area(item: Item): number {
  return item.baseW * item.baseH;
}

function maxSide(item: Item): number {
  return Math.max(item.baseW, item.baseH);
}

function perimeter(item: Item): number {
  return item.baseW + item.baseH;
}

const SORT_MODES: SortMode[] = [
  {
    name: 'area',
    compare: (a, b) => area(b) - area(a) || maxSide(b) - maxSide(a) || a.chart - b.chart,
  },
  {
    name: 'max-side',
    compare: (a, b) => maxSide(b) - maxSide(a) || area(b) - area(a) || a.chart - b.chart,
  },
  {
    name: 'perimeter',
    compare: (a, b) => perimeter(b) - perimeter(a) || area(b) - area(a) || a.chart - b.chart,
  },
  {
    name: 'height',
    compare: (a, b) => b.baseH - a.baseH || b.baseW - a.baseW || a.chart - b.chart,
  },
];

function scoreCandidate(
  heuristic: Heuristic,
  free: Rect,
  candidate: { w: number; h: number },
): number[] {
  const leftW = free.w - candidate.w;
  const leftH = free.h - candidate.h;
  const short = Math.min(leftW, leftH);
  const long = Math.max(leftW, leftH);
  switch (heuristic) {
    case 'blsf':
      return [long, short];
    case 'baf':
      return [free.w * free.h - candidate.w * candidate.h, short];
    case 'bl':
      return [free.y + candidate.h, free.x];
    case 'bssf':
    default:
      return [short, long];
  }
}

function compareScores(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** One MaxRects pass with a fixed sort order and free-rect heuristic. Every
 * placement splits the intersecting maximal free rectangles, then prunes
 * rectangles contained by another. */
function packWith(
  items: Item[],
  resolution: number,
  padding: number,
  allowRotation: boolean,
  heuristic: Heuristic,
  sorter: SortMode,
): Placement[] | null {
  const free: Rect[] = [{ x: 0, y: 0, w: resolution, h: resolution }];
  const sorted = [...items].sort(sorter.compare);
  const placements: Placement[] = [];

  for (const item of sorted) {
    let best: {
      x: number;
      y: number;
      w: number;
      h: number;
      rotation: 0 | 90;
      score: number[];
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
        const score = scoreCandidate(heuristic, rect, candidate);
        const better = best === null
          || compareScores(score, best.score) < 0
          || (compareScores(score, best.score) === 0 && rect.y < best.y)
          || (compareScores(score, best.score) === 0 && rect.y === best.y && rect.x < best.x)
          || (compareScores(score, best.score) === 0 && rect.y === best.y && rect.x === best.x
            && candidate.rotation === 0 && best.rotation === 90);
        if (better) {
          best = {
            x: rect.x,
            y: rect.y,
            w: candidate.w,
            h: candidate.h,
            rotation: candidate.rotation,
            score,
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

function placementExtent(placements: Placement[]): { width: number; height: number; side: number } {
  let width = 0;
  let height = 0;
  for (const placement of placements) {
    width = Math.max(width, placement.x + placement.w);
    height = Math.max(height, placement.y + placement.h);
  }
  return { width, height, side: Math.max(width, height) };
}

/** Tries every MaxRects heuristic and item order, keeping the layout with the
 * smallest square footprint. Smaller footprints leave more room when the
 * caller scales the charts up to fill the atlas. */
function packRectangles(items: Item[], resolution: number, padding: number, allowRotation: boolean): Placement[] | null {
  let best: Placement[] | null = null;
  let bestExtent = { width: Infinity, height: Infinity, side: Infinity };
  const sorters = items.length <= 64 ? SORT_MODES : [SORT_MODES[0]];
  const heuristics: Heuristic[] = items.length <= 64 ? ['bssf', 'blsf', 'baf', 'bl'] : ['bssf'];
  for (const sorter of sorters) {
    for (const heuristic of heuristics) {
      const attempt = packWith(items, resolution, padding, allowRotation, heuristic, sorter);
      if (!attempt) continue;
      const extent = placementExtent(attempt);
      if (extent.side < bestExtent.side
        || (extent.side === bestExtent.side && extent.width + extent.height < bestExtent.width + bestExtent.height)) {
        best = attempt;
        bestExtent = extent;
      }
    }
  }
  return best;
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

/** Union of the chart bounds. Concave placements may overlap their bounds, so
 * summing rectangle areas would overstate atlas use. */
function bboxUnionOccupancy(placements: ChartPlacement[], resolution: number): number {
  const grid = Math.min(1024, Math.max(1, Math.round(resolution)));
  const mask = new Uint8Array(grid * grid);
  const factor = grid / resolution;
  for (const placement of placements) {
    const minX = Math.max(0, Math.floor(placement.x * factor));
    const minY = Math.max(0, Math.floor(placement.y * factor));
    const maxX = Math.min(grid, Math.ceil((placement.x + placement.width) * factor));
    const maxY = Math.min(grid, Math.ceil((placement.y + placement.height) * factor));
    for (let y = minY; y < maxY; y += 1) {
      mask.fill(1, y * grid + minX, y * grid + maxX);
    }
  }
  let covered = 0;
  for (let index = 0; index < mask.length; index += 1) covered += mask[index];
  return covered / (grid * grid);
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

  const iterations = options.fitIterations ?? 18;
  const fitToAtlas = Boolean(options.fitToAtlas) && density.charts.length <= 64;
  let best: Attempt | null = null;
  let bestScale = 1;
  const hasConcaveChart = density.charts.some((chart) => {
    const width = chart.bbox.maxU - chart.bbox.minU;
    const height = chart.bbox.maxV - chart.bbox.minV;
    const boundsArea = width * height;
    return boundsArea > 1e-12 && chart.uvArea / boundsArea < 0.85;
  });
  const maxChartTriangles = density.charts.reduce(
    (max, chart) => Math.max(max, chart.triangles.length),
    0,
  );
  const useConcave = resolution >= 64
    && density.charts.length <= 16
    && maxChartTriangles >= 512
    && hasConcaveChart;
  if (useConcave) {
    const grid = Math.min(1024, resolution);
    let concave = packConcaveCharts(density.charts, {
      grid,
      resolution,
      padding,
      allowRotation: options.allowRotation,
      scale: 1,
      fill: fitToAtlas,
    });
    let fittedScale = 1;
    if (!concave) {
      let low = 1e-4;
      let high = 1;
      for (let iteration = 0; iteration < Math.min(10, iterations); iteration += 1) {
        const mid = (low + high) / 2;
        const attempt = packConcaveCharts(density.charts, {
          grid,
          resolution,
          padding,
          allowRotation: options.allowRotation,
          scale: mid,
          fill: false,
        });
        if (attempt) {
          concave = attempt;
          fittedScale = mid;
          low = mid;
        } else {
          high = mid;
        }
      }
      if (concave && fitToAtlas) {
        concave = packConcaveCharts(density.charts, {
          grid,
          resolution,
          padding,
          allowRotation: options.allowRotation,
          scale: fittedScale,
          fill: true,
        }) ?? concave;
      }
    }
    if (concave) {
      best = {
        scale: concave.scale,
        placements: concave.placements.map((placement: ConcavePlacement): Placement => ({
          chart: placement.chart,
          x: placement.x,
          y: placement.y,
          w: placement.width,
          h: placement.height,
          rotation: placement.rotation,
          inner: true,
        })),
        bboxOccupancy: 0,
      };
      bestScale = concave.scale;
    }
  }
  const fitRects = (): Attempt | null => {
    let rect = attemptPack(density.charts, resolution, padding, options.allowRotation, 1);
    if (!rect) return null;
    if (!fitToAtlas) return rect;
    let low = 1;
    let high = 2;
    let highAttempt = attemptPack(density.charts, resolution, padding, options.allowRotation, high);
    let expansions = 0;
    while (highAttempt && high < 8 && expansions < 3) {
      low = high;
      rect = highAttempt;
      high *= 2;
      highAttempt = attemptPack(density.charts, resolution, padding, options.allowRotation, high);
      expansions += 1;
    }
    if (highAttempt) {
      rect = highAttempt;
    } else {
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const mid = (low + high) / 2;
        const attempt = attemptPack(density.charts, resolution, padding, options.allowRotation, mid);
        if (attempt) {
          rect = attempt;
          low = mid;
        } else {
          high = mid;
        }
      }
    }
    return rect;
  };
  if (best && fitToAtlas) {
    const rect = fitRects();
    if (rect && rect.scale > best.scale + 1e-6) {
      best = rect;
      bestScale = rect.scale;
    }
  }
  if (!best) {
    best = fitRects();
    if (!best) {
      const minimumScale = 1e-4;
      let low = minimumScale;
      let high = 1;
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
  bestScale = best.scale;
  const placements: ChartPlacement[] = best.placements.map((placement) => {
    if (placement.inner) {
      return {
        chart: placement.chart,
        x: placement.x,
        y: placement.y,
        width: Math.max(1, placement.w),
        height: Math.max(1, placement.h),
        rotation: placement.rotation,
      };
    }
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

  const bboxOccupancy = bboxUnionOccupancy(placements, resolution);
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
      code: 'density-reduced',
      message: `Atlas fit reduced texel density to ${achievedTexelDensity.toFixed(1)} px/unit.`,
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
    bboxOccupancy: Number(bboxOccupancy.toFixed(6)),
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
    bboxOccupancy,
    stats,
    issues,
  };
}
