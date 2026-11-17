import { describe, expect, it } from 'vitest';
import { conditionMesh } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import { detectSymmetry, reflectPoint } from '../src/lib/unwrap/symmetry';
import { makePlaneGrid } from './helpers/meshes';

describe('mirror symmetry detection', () => {
  it('finds the x mirror plane of a planar patch and marks its center seam', () => {
    const raw = makePlaneGrid(4, 2);
    const { mesh } = conditionMesh(raw);
    const topology = buildTopology(mesh);
    const result = detectSymmetry(mesh, topology);
    expect(result.plane).not.toBeNull();
    const plane = result.plane!;
    expect(Math.abs(plane.normal[0])).toBeCloseTo(1, 6);
    expect(plane.normal[1]).toBeCloseTo(0, 6);
    expect(plane.normal[2]).toBeCloseTo(0, 6);
    expect(plane.offset).toBeCloseTo(0, 6);
    expect(plane.score).toBeCloseTo(1, 6);
    expect(plane.positiveVertices).toBeGreaterThan(0);
    expect(plane.negativeVertices).toBeGreaterThan(0);
    expect(result.seamCount).toBeGreaterThan(0);

    let seamOnPlane = 0;
    for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
      if (!result.seamEdge[edgeIndex]) continue;
      const edge = topology.edges[edgeIndex];
      for (const vertex of [edge.a, edge.b]) {
        const x = mesh.positions[vertex * 3];
        expect(Math.abs(x)).toBeLessThan(1e-6);
      }
      seamOnPlane += 1;
    }
    expect(seamOnPlane).toBe(result.seamCount);
  });

  it('rejects a mesh without bilateral symmetry', () => {
    const raw = makePlaneGrid(4, 2);
    const positions = Array.from(raw.positions);
    for (let index = 0; index < positions.length; index += 3) {
      const x = positions[index];
      const z = positions[index + 2];
      if (x > 0.2) positions[index + 1] = Math.sin(z * 3.1) * 0.35 + x * 0.17;
    }
    const { mesh } = conditionMesh({ ...raw, positions: new Float32Array(positions) });
    const topology = buildTopology(mesh);
    const result = detectSymmetry(mesh, topology);
    expect(result.plane).toBeNull();
  });

  it('finds a mirror plane that is not aligned to a world axis', () => {
    const raw = makePlaneGrid(4, 2);
    const angle = 0.43;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const positions = Array.from(raw.positions);
    for (let index = 0; index < positions.length; index += 3) {
      const x = positions[index];
      const z = positions[index + 2];
      positions[index] = x * cosine + z * sine;
      positions[index + 2] = -x * sine + z * cosine;
    }
    const { mesh } = conditionMesh({ ...raw, positions: new Float32Array(positions) });
    const topology = buildTopology(mesh);
    const result = detectSymmetry(mesh, topology);
    expect(result.plane).not.toBeNull();
    expect(result.plane!.score).toBeGreaterThan(0.9);
    expect(result.seamCount).toBeGreaterThan(0);
    expect(Math.abs(result.plane!.normal[0])).toBeGreaterThan(0.2);
    expect(Math.abs(result.plane!.normal[2])).toBeGreaterThan(0.2);
  });

  it('reflects points back across the detected plane', () => {
    const raw = makePlaneGrid(4, 2);
    const { mesh } = conditionMesh(raw);
    const topology = buildTopology(mesh);
    const plane = detectSymmetry(mesh, topology).plane!;
    const [x, y, z] = reflectPoint(0.7, 0.2, 0.3, plane);
    expect(Math.abs(x)).toBeCloseTo(0.7, 6);
    expect(y).toBeCloseTo(0.2, 6);
    expect(z).toBeCloseTo(0.3, 6);
  });
});
