import type { ChartUv } from './types';

export type ChartAlignmentResult = {
  charts: ChartUv[];
  rotated: number;
  areaBefore: number;
  areaAfter: number;
};

function bboxOf(uvs: Float32Array): ChartUv['bbox'] {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let index = 0; index < uvs.length; index += 2) {
    const u = uvs[index];
    const v = uvs[index + 1];
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (!Number.isFinite(minU)) return { minU: 0, minV: 0, maxU: 0, maxV: 0 };
  return { minU, minV, maxU, maxV };
}

function bboxArea(bbox: ChartUv['bbox']): number {
  return (bbox.maxU - bbox.minU) * (bbox.maxV - bbox.minV);
}

function rotatedUvs(chart: ChartUv, angle: number): Float32Array {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const centerU = (chart.bbox.minU + chart.bbox.maxU) / 2;
  const centerV = (chart.bbox.minV + chart.bbox.maxV) / 2;
  const uvs = new Float32Array(chart.uvs.length);
  for (let index = 0; index < chart.uvs.length; index += 2) {
    const u = chart.uvs[index] - centerU;
    const v = chart.uvs[index + 1] - centerV;
    uvs[index] = u * cosine - v * sine + centerU;
    uvs[index + 1] = u * sine + v * cosine + centerV;
  }
  return uvs;
}

/** Rotates each chart in UV space to the orientation with the smallest
 * axis-aligned bounding box. This is xatlas's rotateChartsToAxis heuristic:
 * charts keep their shape and density, but the packer sees less wasted
 * bounding area. */
export function alignChartsToAxes(charts: ChartUv[]): ChartAlignmentResult {
  let areaBefore = 0;
  let areaAfter = 0;
  let rotated = 0;
  const aligned = charts.map((chart) => {
    const originalBbox = bboxOf(chart.uvs);
    const originalArea = bboxArea(originalBbox);
    areaBefore += originalArea;
    let bestAngle = 0;
    let bestUvs = chart.uvs;
    let bestBbox = originalBbox;
    let bestArea = originalArea;
    const coarse = 5 * (Math.PI / 180);
    for (let step = 0; step < 18; step += 1) {
      const angle = step * coarse;
      const uvs = rotatedUvs(chart, angle);
      const bbox = bboxOf(uvs);
      const area = bboxArea(bbox);
      if (area < bestArea - 1e-9) {
        bestArea = area;
        bestAngle = angle;
        bestUvs = uvs;
        bestBbox = bbox;
      }
    }
    const fine = 0.5 * (Math.PI / 180);
    for (let step = -8; step <= 8; step += 1) {
      if (step === 0) continue;
      const angle = bestAngle + step * fine;
      const uvs = rotatedUvs(chart, angle);
      const bbox = bboxOf(uvs);
      const area = bboxArea(bbox);
      if (area < bestArea - 1e-9) {
        bestArea = area;
        bestAngle = angle;
        bestUvs = uvs;
        bestBbox = bbox;
      }
    }
    areaAfter += bestArea;
    if (Math.abs(bestAngle) < 1e-9) return chart;
    rotated += 1;
    return {
      ...chart,
      uvs: bestUvs,
      bbox: bestBbox,
    };
  });
  return { charts: aligned, rotated, areaBefore, areaAfter };
}
