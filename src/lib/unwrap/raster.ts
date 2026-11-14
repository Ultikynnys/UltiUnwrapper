/** UV triangle rasterizer shared by occupancy stats and overlap validation.
 * UV (0,0) is the texture bottom-left; the raster grid is top-left origin, so V
 * is flipped here. */

export type RasterTriangle = {
  uv: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
};

export type RasterWrite = (
  px: number,
  py: number,
  w0: number,
  w1: number,
  w2: number,
  triangle: number,
) => void;

export type RasterOptions = {
  /** Ignore texels on triangle edges. Used for overlap detection so two
   * triangles meeting on a shared 3D edge do not count as overlapping. */
  interior?: boolean;
};

const EPSILON = 1e-9;

function edge(
  ax: number, ay: number,
  bx: number, by: number,
  px: number, py: number,
): number {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

export function uvToTexturePoint(
  uv: readonly [number, number],
  width: number,
  height: number,
): [number, number] {
  return [uv[0] * width, (1 - uv[1]) * height];
}

/** Rasterizes every triangle at pixel centers, invoking `write` for each
 * covered texel. Triangles may extend outside the atlas; the bounding box is
 * clipped, so the result is always a valid `width × height` grid. */
export function rasterizeTriangles(
  width: number,
  height: number,
  triangles: readonly RasterTriangle[],
  write: RasterWrite,
  options: RasterOptions = {},
): void {
  if (width <= 0 || height <= 0) return;
  for (let triangle = 0; triangle < triangles.length; triangle += 1) {
    const [a, b, c] = triangles[triangle].uv;
    const ax = a[0] * width;
    const ay = (1 - a[1]) * height;
    const bx = b[0] * width;
    const by = (1 - b[1]) * height;
    const cx = c[0] * width;
    const cy = (1 - c[1]) * height;
    const signedArea = edge(ax, ay, bx, by, cx, cy);
    if (Math.abs(signedArea) <= EPSILON) continue;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let py = minY; py <= maxY; py += 1) {
      const sampleY = py + 0.5;
      for (let px = minX; px <= maxX; px += 1) {
        const sampleX = px + 0.5;
        const w0 = edge(bx, by, cx, cy, sampleX, sampleY) / signedArea;
        const w1 = edge(cx, cy, ax, ay, sampleX, sampleY) / signedArea;
        const w2 = edge(ax, ay, bx, by, sampleX, sampleY) / signedArea;
        const inside = options.interior
          ? w0 > EPSILON && w1 > EPSILON && w2 > EPSILON
          : w0 >= -EPSILON && w1 >= -EPSILON && w2 >= -EPSILON;
        if (inside) {
          write(px, py, w0, w1, w2, triangle);
        }
      }
    }
  }
}

export type CoverageResult = {
  width: number;
  height: number;
  /** Per-texel coverage, saturated at 2. */
  counts: Uint8Array;
  /** Texels with at least one triangle. */
  covered: number;
  /** Texels with two or more triangles. */
  overlapping: number;
};

export function rasterizeCoverage(
  width: number,
  height: number,
  triangles: readonly RasterTriangle[],
  options: RasterOptions = {},
): CoverageResult {
  const counts = new Uint8Array(width * height);
  let covered = 0;
  let overlapping = 0;
  rasterizeTriangles(width, height, triangles, (px, py) => {
    const index = py * width + px;
    if (counts[index] === 0) covered += 1;
    if (counts[index] === 1) overlapping += 1;
    if (counts[index] < 2) counts[index] += 1;
  }, options);
  return { width, height, counts, covered, overlapping };
}
