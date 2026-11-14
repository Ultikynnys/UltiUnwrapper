export type NormalEquationSystem = {
  size: number;
  /** Applies the symmetric positive-definite normal matrix to `x`. */
  apply(x: Float64Array, out: Float64Array): void;
  /** Diagonal of the normal matrix, used as a Jacobi preconditioner. */
  diagonal: Float64Array;
};

export type ConjugateGradientOptions = {
  tolerance: number;
  maxIterations: number;
};

export type ConjugateGradientResult = {
  x: Float64Array;
  iterations: number;
  /** Final relative residual, or 0 when the right-hand side is zero. */
  residual: number;
  converged: boolean;
};

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function norm(a: Float64Array): number {
  return Math.sqrt(dot(a, a));
}

/** Jacobi-preconditioned conjugate gradient for A x = b, where A is only
 * available through `apply`. The solver keeps the iterate finite: a
 * non-positive curvature or a NaN step stops the loop and returns the last
 * usable vector with `converged: false`. */
export function solveConjugateGradient(
  system: NormalEquationSystem,
  rhs: Float64Array,
  initial: Float64Array,
  options: ConjugateGradientOptions,
): ConjugateGradientResult {
  const size = system.size;
  if (rhs.length !== size || initial.length !== size) {
    throw new Error('Conjugate-gradient vectors do not match the system size.');
  }
  const x = Float64Array.from(initial);
  const residualVector = new Float64Array(size);
  const product = new Float64Array(size);

  system.apply(x, product);
  for (let i = 0; i < size; i += 1) residualVector[i] = rhs[i] - product[i];

  const rhsNorm = norm(rhs);
  if (rhsNorm === 0) {
    return { x, iterations: 0, residual: 0, converged: true };
  }
  let residualNorm = norm(residualVector);
  if (residualNorm / rhsNorm <= options.tolerance) {
    return { x, iterations: 0, residual: residualNorm / rhsNorm, converged: true };
  }

  const z = new Float64Array(size);
  const direction = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    const diagonal = system.diagonal[i];
    z[i] = residualVector[i] / (diagonal > 0 ? diagonal : 1);
  }
  direction.set(z);
  let rz = dot(residualVector, z);
  let iterations = 0;
  let converged = false;

  for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
    iterations = iteration + 1;
    system.apply(direction, product);
    const curvature = dot(direction, product);
    if (!(curvature > 0) || !Number.isFinite(curvature)) break;
    const alpha = rz / curvature;
    if (!Number.isFinite(alpha)) break;
    for (let i = 0; i < size; i += 1) {
      x[i] += alpha * direction[i];
      residualVector[i] -= alpha * product[i];
    }
    residualNorm = norm(residualVector);
    const residual = residualNorm / rhsNorm;
    if (residual <= options.tolerance) {
      return { x, iterations, residual, converged: true };
    }
    for (let i = 0; i < size; i += 1) {
      const diagonal = system.diagonal[i];
      z[i] = residualVector[i] / (diagonal > 0 ? diagonal : 1);
    }
    const rzNext = dot(residualVector, z);
    if (!(rzNext > 0) || !Number.isFinite(rzNext)) break;
    const beta = rzNext / rz;
    for (let i = 0; i < size; i += 1) direction[i] = z[i] + beta * direction[i];
    rz = rzNext;
  }

  const finalResidual = residualNorm / rhsNorm;
  return {
    x,
    iterations,
    residual: Number.isFinite(finalResidual) ? finalResidual : Infinity,
    converged,
  };
}
