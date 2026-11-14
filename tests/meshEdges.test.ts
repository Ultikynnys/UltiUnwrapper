import { describe, expect, it } from 'vitest';
import { conditionMesh, triangleNormal } from '../src/lib/unwrap/mesh';
import type { ConditionedMesh } from '../src/lib/unwrap/types';
import { rawMesh } from './helpers/meshes';

function emptyMesh(): ConditionedMesh {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    objectOfTriangle: new Uint32Array([0]),
    materialOfTriangle: new Int32Array([-1]),
    sourceTriangle: new Uint32Array([0]),
    sourceVertex: new Uint32Array([0, 1, 2]),
    objectNames: ['Degenerate'],
    vertexCount: 3,
    triangleCount: 1,
  };
}

describe('conditioning edge cases', () => {
  it('drops non-finite vertices and reports an empty mesh', () => {
    const result = conditionMesh(rawMesh(
      [Number.NaN, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 1, 2],
    ));
    expect(result.mesh.triangleCount).toBe(0);
    expect(result.issues.some((issue) => issue.code === 'empty-mesh')).toBe(true);
    expect(result.stats.triangles).toBe(0);
  });

  it('drops out-of-range and duplicate indices', () => {
    const invalid = conditionMesh(rawMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 99]));
    expect(invalid.mesh.triangleCount).toBe(0);
    expect(invalid.issues.some((issue) => issue.code === 'empty-mesh')).toBe(true);
    const duplicate = conditionMesh(rawMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1]));
    expect(duplicate.mesh.triangleCount).toBe(0);
    expect(duplicate.issues.some((issue) => issue.code === 'empty-mesh')).toBe(true);
  });

  it('handles a completely empty input', () => {
    const result = conditionMesh(rawMesh([], []));
    expect(result.mesh.triangleCount).toBe(0);
    expect(result.stats.inputVertices).toBe(0);
    expect(result.issues.some((issue) => issue.code === 'empty-mesh')).toBe(true);
  });

  it('returns a safe normal for a collinear triangle', () => {
    expect(triangleNormal(emptyMesh(), 0)).toEqual([0, 1, 0]);
  });
});
