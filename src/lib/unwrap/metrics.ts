import type { ChartUv, ConditionedMesh } from './types';

export type PercentileSummary = {
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
};

const EPSILON = 1e-12;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Linear-interpolated percentile over a copy of the input. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const count = values.length;
  if (count === 0) return 0;
  const sorted = Float64Array.from(values);
  sorted.sort();
  const position = (count - 1) * clamp01(p);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export function summarize(values: ArrayLike<number>): PercentileSummary {
  const count = values.length;
  if (count === 0) return { min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const value = values[i];
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  return {
    min,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max,
    mean: sum / count,
  };
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

export function signedTriangleArea2D(
  u0: number, v0: number,
  u1: number, v1: number,
  u2: number, v2: number,
): number {
  return 0.5 * ((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0));
}

/** Per-face metrics in global triangle order. Angle distortion is the mean
 * absolute difference of the three corner angles, in degrees. Area distortion
 * is the absolute base-2 log of the triangle's area share inside its chart. */
export function computeFaceMetrics(
  mesh: ConditionedMesh,
  charts: ChartUv[],
  triangleUvs: Float32Array,
): { angleDistortion: Float32Array; areaDistortion: Float32Array; flipped: Uint8Array } {
  const angleDistortion = new Float32Array(mesh.triangleCount);
  const areaDistortion = new Float32Array(mesh.triangleCount);
  const flipped = new Uint8Array(mesh.triangleCount);

  for (const chart of charts) {
    const chartUvArea = chart.uvArea;
    const chartWorldArea = chart.worldArea;
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

      const uvOffset = triangle * 6;
      const u0 = triangleUvs[uvOffset];
      const v0 = triangleUvs[uvOffset + 1];
      const u1 = triangleUvs[uvOffset + 2];
      const v1 = triangleUvs[uvOffset + 3];
      const u2 = triangleUvs[uvOffset + 4];
      const v2 = triangleUvs[uvOffset + 5];

      const angle3A = angleAt(ax, ay, az, bx, by, bz, cx, cy, cz);
      const angle3B = angleAt(bx, by, bz, cx, cy, cz, ax, ay, az);
      const angle3C = 180 - angle3A - angle3B;
      const angle2A = angleAt(u0, v0, 0, u1, v1, 0, u2, v2, 0);
      const angle2B = angleAt(u1, v1, 0, u2, v2, 0, u0, v0, 0);
      const angle2C = 180 - angle2A - angle2B;
      angleDistortion[triangle] = (
        Math.abs(angle3A - angle2A)
        + Math.abs(angle3B - angle2B)
        + Math.abs(angle3C - angle2C)
      ) / 3;

      const uvArea = signedTriangleArea2D(u0, v0, u1, v1, u2, v2);
      if (uvArea <= EPSILON) flipped[triangle] = 1;
      const uvMagnitude = Math.abs(uvArea);
      const worldArea = 0.5 * Math.hypot(
        (by - ay) * (cz - az) - (bz - az) * (cy - ay),
        (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
        (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
      );
      if (
        uvMagnitude > EPSILON
        && worldArea > EPSILON
        && chartUvArea > EPSILON
        && chartWorldArea > EPSILON
      ) {
        const ratio = (uvMagnitude / chartUvArea) / (worldArea / chartWorldArea);
        areaDistortion[triangle] = Math.abs(Math.log2(ratio));
      }
    }
  }

  return { angleDistortion, areaDistortion, flipped };
}
