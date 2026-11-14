import { solveConjugateGradient, type NormalEquationSystem } from './solver';

export type LscmTriangle = {
  a: number;
  b: number;
  c: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
};

export type LscmOptions = {
  tolerance?: number;
  maxIterations?: number;
};

export type LscmResult = {
  /** 2 floats per chart-local vertex. */
  uvs: Float32Array;
  iterations: number;
  residual: number;
  converged: boolean;
};

const EPSILON = 1e-15;

/** Least-squares conformal map with two pinned vertices.
 *
 * For each triangle the Cauchy-Riemann residual is written as two rows over
 * [u0, v0, u1, v1, u2, v2]. The normal equations are solved with a
 * Jacobi-preconditioned conjugate gradient, so no sparse matrix is ever
 * assembled. The pins keep the global translation, rotation, and scale of the
 * projection, which also gives the solver a well-conditioned start. */
export function solveLscm(
  vertexCount: number,
  triangles: readonly LscmTriangle[],
  projected: Float32Array,
  pinA: number,
  pinB: number,
  options: LscmOptions = {},
): LscmResult {
  const triangleCount = triangles.length;
  const u1 = new Float64Array(triangleCount * 3);
  const v1 = new Float64Array(triangleCount * 3);
  const u2 = new Float64Array(triangleCount * 3);
  const v2 = new Float64Array(triangleCount * 3);
  const diagonal = new Float64Array(vertexCount * 2);
  const ids = new Int32Array(triangleCount * 3);

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const tri = triangles[triangle];
    const corners = [tri.a, tri.b, tri.c];
    const xs = [tri.ax, tri.bx, tri.cx];
    const ys = [tri.ay, tri.by, tri.cy];
    const signedArea = 0.5 * (
      (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0])
    );
    const area = Math.abs(signedArea);
    const weight = area > EPSILON ? 1 / Math.sqrt(area) : 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const next = (corner + 1) % 3;
      const previous = (corner + 2) % 3;
      const index = triangle * 3 + corner;
      ids[index] = corners[corner];
      const a = (ys[next] - ys[previous]) * weight;
      const b = (xs[previous] - xs[next]) * weight;
      u1[index] = a;
      v1[index] = -b;
      u2[index] = b;
      v2[index] = a;
      const vertex = corners[corner] * 2;
      diagonal[vertex] += a * a + b * b;
      diagonal[vertex + 1] += a * a + b * b;
    }
  }

  const applyNormal = (x: Float64Array, out: Float64Array): void => {
    out.fill(0);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const base = triangle * 3;
      const ia = ids[base] * 2;
      const ib = ids[base + 1] * 2;
      const ic = ids[base + 2] * 2;
      const row1 = u1[base] * x[ia] + v1[base] * x[ia + 1]
        + u1[base + 1] * x[ib] + v1[base + 1] * x[ib + 1]
        + u1[base + 2] * x[ic] + v1[base + 2] * x[ic + 1];
      const row2 = u2[base] * x[ia] + v2[base] * x[ia + 1]
        + u2[base + 1] * x[ib] + v2[base + 1] * x[ib + 1]
        + u2[base + 2] * x[ic] + v2[base + 2] * x[ic + 1];
      out[ia] += u1[base] * row1 + u2[base] * row2;
      out[ia + 1] += v1[base] * row1 + v2[base] * row2;
      out[ib] += u1[base + 1] * row1 + u2[base + 1] * row2;
      out[ib + 1] += v1[base + 1] * row1 + v2[base + 1] * row2;
      out[ic] += u1[base + 2] * row1 + u2[base + 2] * row2;
      out[ic + 1] += v1[base + 2] * row1 + v2[base + 2] * row2;
    }
  };

  const freeOf = new Int32Array(vertexCount * 2).fill(-1);
  const freeIndices: number[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (vertex === pinA || vertex === pinB) continue;
    for (let axis = 0; axis < 2; axis += 1) {
      const fullIndex = vertex * 2 + axis;
      freeOf[fullIndex] = freeIndices.length;
      freeIndices.push(fullIndex);
    }
  }
  const freeCount = freeIndices.length;
  if (freeCount === 0) {
    return { uvs: Float32Array.from(projected), iterations: 0, residual: 0, converged: true };
  }

  const pinned = new Float64Array(vertexCount * 2);
  pinned[pinA * 2] = projected[pinA * 2];
  pinned[pinA * 2 + 1] = projected[pinA * 2 + 1];
  pinned[pinB * 2] = projected[pinB * 2];
  pinned[pinB * 2 + 1] = projected[pinB * 2 + 1];

  const pinnedProduct = new Float64Array(vertexCount * 2);
  applyNormal(pinned, pinnedProduct);
  const rhs = new Float64Array(freeCount);
  const initial = new Float64Array(freeCount);
  const diagonalFree = new Float64Array(freeCount);
  for (let free = 0; free < freeCount; free += 1) {
    const fullIndex = freeIndices[free];
    rhs[free] = -pinnedProduct[fullIndex];
    initial[free] = projected[fullIndex];
    diagonalFree[free] = diagonal[fullIndex];
  }

  const fullScratch = new Float64Array(vertexCount * 2);
  const outScratch = new Float64Array(vertexCount * 2);
  const system: NormalEquationSystem = {
    size: freeCount,
    diagonal: diagonalFree,
    apply(x: Float64Array, out: Float64Array): void {
      fullScratch.fill(0);
      for (let free = 0; free < freeCount; free += 1) {
        fullScratch[freeIndices[free]] = x[free];
      }
      applyNormal(fullScratch, outScratch);
      for (let free = 0; free < freeCount; free += 1) {
        out[free] = outScratch[freeIndices[free]];
      }
    },
  };

  const result = solveConjugateGradient(system, rhs, initial, {
    tolerance: options.tolerance ?? 1e-10,
    maxIterations: options.maxIterations ?? Math.min(4 * freeCount, 2000),
  });

  const uvs = Float32Array.from(projected);
  uvs[pinA * 2] = projected[pinA * 2];
  uvs[pinA * 2 + 1] = projected[pinA * 2 + 1];
  uvs[pinB * 2] = projected[pinB * 2];
  uvs[pinB * 2 + 1] = projected[pinB * 2 + 1];
  for (let free = 0; free < freeCount; free += 1) {
    const value = result.x[free];
    if (!Number.isFinite(value)) {
      return { uvs: Float32Array.from(projected), iterations: result.iterations, residual: Infinity, converged: false };
    }
    uvs[freeIndices[free]] = value;
  }
  return {
    uvs,
    iterations: result.iterations,
    residual: result.residual,
    converged: result.converged,
  };
}
