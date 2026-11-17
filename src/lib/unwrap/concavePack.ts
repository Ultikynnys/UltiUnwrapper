import { rasterizeTriangles, type RasterTriangle } from './raster';
import type { ChartUv } from './types';

export type ConcaveRotation = 0 | 90 | 180 | 270;

export type ConcavePlacement = {
  chart: number;
  rotation: ConcaveRotation;
  /** Chart bounds in atlas pixels, bottom-left origin. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ConcavePackOptions = {
  /** Working raster edge length. Lower values are faster but less precise. */
  grid: number;
  /** Output atlas edge length in pixels. */
  resolution: number;
  /** Minimum gap between chart triangles in atlas pixels. */
  padding: number;
  allowRotation: boolean;
  /** Initial texel-density scale. */
  scale: number;
  /** Grow the completed layout uniformly until it fills the working grid. */
  fill: boolean;
};

export type ConcavePackResult = {
  placements: ConcavePlacement[];
  width: number;
  height: number;
  scale: number;
  /** Sum of occupied mask pixels on the working grid, including padding. */
  usedArea: number;
};

type OrientedMask = {
  rotation: ConcaveRotation;
  contentW: number;
  contentH: number;
  outerW: number;
  outerH: number;
  pad: number;
  rows: Uint32Array;
  words: number;
  area: number;
};

type ShapeItem = {
  chart: ChartUv;
  masks: OrientedMask[];
  area: number;
};

type Attempt = {
  placements: Array<{
    chart: number;
    rotation: ConcaveRotation;
    x: number;
    y: number;
    mask: OrientedMask;
  }>;
  width: number;
  height: number;
  usedArea: number;
};

function rotateMask(
  source: Uint8Array,
  width: number,
  height: number,
  rotation: ConcaveRotation,
): { data: Uint8Array; width: number; height: number } {
  if (rotation === 0) return { data: source, width, height };
  const rotatedWidth = rotation === 90 || rotation === 270 ? height : width;
  const rotatedHeight = rotation === 90 || rotation === 270 ? width : height;
  const data = new Uint8Array(rotatedWidth * rotatedHeight);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!source[y * width + x]) continue;
      let dx: number;
      let dy: number;
      if (rotation === 90) {
        dx = y;
        dy = width - 1 - x;
      } else if (rotation === 180) {
        dx = width - 1 - x;
        dy = height - 1 - y;
      } else {
        dx = height - 1 - y;
        dy = x;
      }
      data[dy * rotatedWidth + dx] = 1;
    }
  }
  return { data, width: rotatedWidth, height: rotatedHeight };
}

function dilate(
  source: Uint8Array,
  width: number,
  height: number,
  pad: number,
): Uint8Array {
  if (pad <= 0) return source;
  const outerWidth = width + pad * 2;
  const outerHeight = height + pad * 2;
  const horizontal = new Uint8Array(outerWidth * height);
  const prefix = new Uint32Array(Math.max(width, height, outerWidth) + 1);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    prefix[0] = 0;
    for (let x = 0; x < width; x += 1) {
      prefix[x + 1] = prefix[x] + source[row + x];
    }
    const outRow = y * outerWidth;
    for (let xOut = 0; xOut < outerWidth; xOut += 1) {
      const left = Math.max(0, xOut - pad * 2);
      const right = Math.min(width, xOut + 1);
      if (right > left && prefix[right] > prefix[left]) horizontal[outRow + xOut] = 1;
    }
  }
  const data = new Uint8Array(outerWidth * outerHeight);
  for (let x = 0; x < outerWidth; x += 1) {
    prefix[0] = 0;
    for (let y = 0; y < height; y += 1) {
      prefix[y + 1] = prefix[y] + horizontal[y * outerWidth + x];
    }
    for (let yOut = 0; yOut < outerHeight; yOut += 1) {
      const top = Math.max(0, yOut - pad * 2);
      const bottom = Math.min(height, yOut + 1);
      if (bottom > top && prefix[bottom] > prefix[top]) data[yOut * outerWidth + x] = 1;
    }
  }
  return data;
}

function toRows(
  data: Uint8Array,
  width: number,
  height: number,
): { rows: Uint32Array; words: number; area: number } {
  const words = (width + 31) >> 5;
  const rows = new Uint32Array(words * height);
  let area = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!data[y * width + x]) continue;
      rows[y * words + (x >> 5)] |= 1 << (x & 31);
      area += 1;
    }
  }
  return { rows, words, area };
}

function baseMask(chart: ChartUv, width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height);
  const baseWidth = chart.bbox.maxU - chart.bbox.minU;
  const baseHeight = chart.bbox.maxV - chart.bbox.minV;
  if (!(baseWidth > 0) || !(baseHeight > 0)) return data;
  const triangles: RasterTriangle[] = [];
  for (let local = 0; local < chart.triangles.length; local += 1) {
    const corners: [[number, number], [number, number], [number, number]] = [[0, 0], [0, 0], [0, 0]];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = chart.localIndices[local * 3 + corner];
      const u = (chart.uvs[vertex * 2] - chart.bbox.minU) / baseWidth;
      const v = (chart.uvs[vertex * 2 + 1] - chart.bbox.minV) / baseHeight;
      corners[corner] = [u, 1 - v];
    }
    triangles.push({ uv: corners });
  }
  rasterizeTriangles(width, height, triangles, (x, y) => {
    data[y * width + x] = 1;
  });
  return data;
}

function buildMasks(
  chart: ChartUv,
  grid: number,
  padding: number,
  resolution: number,
  scale: number,
  allowRotation: boolean,
): OrientedMask[] {
  const baseWidth = chart.bbox.maxU - chart.bbox.minU;
  const baseHeight = chart.bbox.maxV - chart.bbox.minV;
  const contentW = Math.max(1, Math.ceil(baseWidth * grid * scale));
  const contentH = Math.max(1, Math.ceil(baseHeight * grid * scale));
  const base = baseMask(chart, contentW, contentH);
  if (!base.some((value) => value !== 0)) {
    base[Math.floor(contentH / 2) * contentW + Math.floor(contentW / 2)] = 1;
  }
  const pad = Math.max(0, Math.round((padding * grid) / resolution));
  const rotations: ConcaveRotation[] = allowRotation ? [0, 90, 180, 270] : [0];
  const masks: OrientedMask[] = [];
  for (const rotation of rotations) {
    const rotated = rotateMask(base, contentW, contentH, rotation);
    const padded = dilate(rotated.data, rotated.width, rotated.height, pad);
    const outerW = rotated.width + pad * 2;
    const outerH = rotated.height + pad * 2;
    const bits = toRows(padded, outerW, outerH);
    masks.push({
      rotation,
      contentW: rotated.width,
      contentH: rotated.height,
      outerW,
      outerH,
      pad,
      rows: bits.rows,
      words: bits.words,
      area: bits.area,
    });
  }
  return masks;
}

function canPlace(
  mask: OrientedMask,
  occupancy: Uint32Array,
  occupancyWords: number,
  grid: number,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x + mask.outerW > grid || y + mask.outerH > grid) return false;
  const wordOffset = x >> 5;
  const shift = x & 31;
  for (let row = 0; row < mask.outerH; row += 1) {
    const maskRow = row * mask.words;
    const occRow = (y + row) * occupancyWords;
    for (let word = 0; word < mask.words; word += 1) {
      const bits = mask.rows[maskRow + word];
      if (!bits) continue;
      const target = wordOffset + word;
      if (target >= occupancyWords) return false;
      const shifted = shift === 0 ? bits : (bits << shift);
      if (shifted & occupancy[occRow + target]) return false;
      if (shift !== 0) {
        const carry = bits >>> (32 - shift);
        if (carry) {
          if (target + 1 >= occupancyWords) return false;
          if (carry & occupancy[occRow + target + 1]) return false;
        }
      }
    }
  }
  return true;
}

function occupy(
  mask: OrientedMask,
  occupancy: Uint32Array,
  occupancyWords: number,
  x: number,
  y: number,
): void {
  const wordOffset = x >> 5;
  const shift = x & 31;
  for (let row = 0; row < mask.outerH; row += 1) {
    const maskRow = row * mask.words;
    const occRow = (y + row) * occupancyWords;
    for (let word = 0; word < mask.words; word += 1) {
      const bits = mask.rows[maskRow + word];
      if (!bits) continue;
      const target = wordOffset + word;
      occupancy[occRow + target] |= shift === 0 ? bits : bits << shift;
      if (shift !== 0) {
        const carry = bits >>> (32 - shift);
        if (carry && target + 1 < occupancyWords) {
          occupancy[occRow + target + 1] |= carry;
        }
      }
    }
  }
}

function findPlacement(
  mask: OrientedMask,
  occupancy: Uint32Array,
  occupancyWords: number,
  grid: number,
  step: number,
): { x: number; y: number } | null {
  const maxX = grid - mask.outerW;
  const maxY = grid - mask.outerH;
  if (maxX < 0 || maxY < 0) return null;
  const xs: number[] = [];
  for (let x = 0; x <= maxX; x += step) xs.push(x);
  if (xs[xs.length - 1] !== maxX) xs.push(maxX);
  const ys: number[] = [];
  for (let y = 0; y <= maxY; y += step) ys.push(y);
  if (ys[ys.length - 1] !== maxY) ys.push(maxY);
  for (const y of ys) {
    for (const x of xs) {
      if (!canPlace(mask, occupancy, occupancyWords, grid, x, y)) continue;
      let bestX = x;
      let bestY = y;
      const lowX = Math.max(0, x - step + 1);
      const lowY = Math.max(0, y - step + 1);
      for (let candidateY = lowY; candidateY <= y; candidateY += 1) {
        for (let candidateX = lowX; candidateX <= x; candidateX += 1) {
          if (candidateY + mask.outerH > bestY + mask.outerH) continue;
          if (candidateY === bestY && candidateX >= bestX) continue;
          if (!canPlace(mask, occupancy, occupancyWords, grid, candidateX, candidateY)) continue;
          bestX = candidateX;
          bestY = candidateY;
        }
      }
      return { x: bestX, y: bestY };
    }
  }
  return null;
}

function packOrder(
  items: ShapeItem[],
  grid: number,
  step: number,
): Attempt | null {
  const occupancyWords = (grid + 31) >> 5;
  const occupancy = new Uint32Array(occupancyWords * grid);
  const placements: Attempt['placements'] = [];
  let usedArea = 0;
  for (const item of items) {
    let best: Attempt['placements'][number] | null = null;
    for (const mask of item.masks) {
      const found = findPlacement(mask, occupancy, occupancyWords, grid, step);
      if (!found) continue;
      const top = found.y + mask.outerH;
      if (!best || top < best.y + best.mask.outerH
        || (top === best.y + best.mask.outerH && found.x < best.x)) {
        best = {
          chart: item.chart.chart,
          rotation: mask.rotation,
          x: found.x,
          y: found.y,
          mask,
        };
      }
    }
    if (!best) return null;
    placements.push(best);
    usedArea += best.mask.area;
    occupy(best.mask, occupancy, occupancyWords, best.x, best.y);
  }
  let width = 0;
  let height = 0;
  for (const placement of placements) {
    width = Math.max(width, placement.x + placement.mask.outerW);
    height = Math.max(height, placement.y + placement.mask.outerH);
  }
  return { placements, width, height, usedArea };
}

function layoutScore(attempt: Attempt): number[] {
  return [Math.max(attempt.width, attempt.height), attempt.width + attempt.height];
}

function compareScore(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Packs chart silhouettes, not their bounding boxes. Charts are rasterized at
 * a working grid, padded by the requested atlas gap, and placed with a
 * bottom-left first-fit search. A chart's rectangle may overlap another's when
 * their occupied pixels do not. */
export function packConcaveCharts(
  charts: ChartUv[],
  options: ConcavePackOptions,
): ConcavePackResult | null {
  const grid = Math.max(8, Math.round(options.grid));
  const step = Math.max(1, Math.round(grid / 256));
  for (const chart of charts) {
    const width = chart.bbox.maxU - chart.bbox.minU;
    const height = chart.bbox.maxV - chart.bbox.minV;
    if (Math.ceil(width * grid * options.scale) > grid
      || Math.ceil(height * grid * options.scale) > grid) {
      return null;
    }
  }
  const items: ShapeItem[] = charts.map((chart) => {
    const masks = buildMasks(
      chart,
      grid,
      options.padding,
      options.resolution,
      options.scale,
      options.allowRotation,
    );
    return {
      chart,
      masks,
      area: (chart.bbox.maxU - chart.bbox.minU) * (chart.bbox.maxV - chart.bbox.minV),
    };
  });
  const orders: ShapeItem[][] = [
    [...items].sort((a, b) => b.area - a.area || a.chart.chart - b.chart.chart),
    [...items].sort((a, b) => Math.max(b.chart.bbox.maxU - b.chart.bbox.minU, b.chart.bbox.maxV - b.chart.bbox.minV)
      - Math.max(a.chart.bbox.maxU - a.chart.bbox.minU, a.chart.bbox.maxV - a.chart.bbox.minV)
      || a.chart.chart - b.chart.chart),
  ];
  let best: Attempt | null = null;
  for (const order of orders) {
    const attempt = packOrder(order, grid, step);
    if (!attempt) continue;
    if (!best || compareScore(layoutScore(attempt), layoutScore(best)) < 0) best = attempt;
  }
  if (!best) return null;

  const fillScale = options.fill && best.width > 0 && best.height > 0
    ? Math.min(grid / best.width, grid / best.height)
    : 1;
  const pixelScale = (options.resolution / grid) * fillScale;
  const placements: ConcavePlacement[] = best.placements.map((placement) => {
    const contentW = placement.mask.contentW;
    const contentH = placement.mask.contentH;
    const contentX = placement.x + placement.mask.pad;
    const contentY = placement.y + placement.mask.pad;
    return {
      chart: placement.chart,
      rotation: placement.rotation,
      x: contentX * pixelScale,
      y: contentY * pixelScale,
      width: contentW * pixelScale,
      height: contentH * pixelScale,
    };
  });
  return {
    placements,
    width: best.width * fillScale,
    height: best.height * fillScale,
    scale: options.scale * fillScale,
    usedArea: best.usedArea * fillScale * fillScale,
  };
}
