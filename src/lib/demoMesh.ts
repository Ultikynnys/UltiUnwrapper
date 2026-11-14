import type { RawMesh } from './unwrap/types';

/** Procedural cube used by the in-app demo; it keeps the UI usable without an
 * asset download. */
export function createDemoCube(size = 2): RawMesh {
  const h = size / 2;
  const positions = [
    -h, -h, -h,
    h, -h, -h,
    h, h, -h,
    -h, h, -h,
    -h, -h, h,
    h, -h, h,
    h, h, h,
    -h, h, h,
  ];
  const indices = [
    4, 5, 6, 4, 6, 7,
    1, 0, 3, 1, 3, 2,
    0, 4, 7, 0, 7, 3,
    5, 1, 2, 5, 2, 6,
    3, 7, 6, 3, 6, 2,
    0, 1, 5, 0, 5, 4,
  ];
  const triangleCount = indices.length / 3;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    objectOfTriangle: new Uint32Array(triangleCount),
    materialOfTriangle: new Int32Array(triangleCount).fill(-1),
    sourceTriangle: new Uint32Array(Array.from({ length: triangleCount }, (_, index) => index)),
    sourceVertex: new Uint32Array(positions.length / 3),
    objectNames: ['Demo cube'],
  };
}
