import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Object3D } from 'three';
import { boundsOf, conditionMesh, triangleNormal, weldVertices } from '../src/lib/unwrap/mesh';
import { buildTopology, topologyStats } from '../src/lib/unwrap/topology';
import { flattenScene } from '../src/lib/threeGeometry';
import {
  makeCube,
  makeDegenerate,
  makeNonManifold,
  makePlaneGrid,
  makeSplitCube,
  makeTwoCubes,
} from './helpers/meshes';

describe('mesh conditioning', () => {
  it('keeps a clean cube intact and computes unit outward normals', () => {
    const { mesh, stats, issues } = conditionMesh(makeCube(2));
    expect(mesh.vertexCount).toBe(8);
    expect(mesh.triangleCount).toBe(12);
    expect(stats.degenerateRemoved).toBe(0);
    expect(issues).toEqual([]);

    for (let tri = 0; tri < mesh.triangleCount; tri += 1) {
      const normal = triangleNormal(mesh, tri);
      expect(Math.hypot(normal[0], normal[1], normal[2])).toBeCloseTo(1, 6);
      const ia = mesh.indices[tri * 3];
      const ib = mesh.indices[tri * 3 + 1];
      const ic = mesh.indices[tri * 3 + 2];
      const cx = (mesh.positions[ia * 3] + mesh.positions[ib * 3] + mesh.positions[ic * 3]) / 3;
      const cy = (mesh.positions[ia * 3 + 1] + mesh.positions[ib * 3 + 1] + mesh.positions[ic * 3 + 1]) / 3;
      const cz = (mesh.positions[ia * 3 + 2] + mesh.positions[ib * 3 + 2] + mesh.positions[ic * 3 + 2]) / 3;
      expect(normal[0] * cx + normal[1] * cy + normal[2] * cz).toBeGreaterThan(0);
    }

    for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
      expect(Math.hypot(
        mesh.normals[vertex * 3],
        mesh.normals[vertex * 3 + 1],
        mesh.normals[vertex * 3 + 2],
      )).toBeCloseTo(1, 6);
    }
  });

  it('welds split face vertices by position', () => {
    const { mesh, stats, issues } = conditionMesh(makeSplitCube(2));
    expect(stats.inputVertices).toBe(24);
    expect(stats.weldedVertices).toBe(8);
    expect(stats.duplicateVertices).toBe(16);
    expect(mesh.triangleCount).toBe(12);
    expect(issues.some((issue) => issue.code === 'duplicate-vertices')).toBe(true);
  });

  it('drops degenerate triangles and reports them', () => {
    const { mesh, stats, issues } = conditionMesh(makeDegenerate());
    expect(mesh.triangleCount).toBe(1);
    expect(stats.degenerateRemoved).toBe(1);
    expect(issues.some((issue) => issue.code === 'degenerate-removed')).toBe(true);
  });

  it('reports an empty mesh instead of throwing', () => {
    const { mesh, issues } = conditionMesh({
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      objectOfTriangle: new Uint32Array(0),
      materialOfTriangle: new Int32Array(0),
      sourceTriangle: new Uint32Array(0),
      sourceVertex: new Uint32Array(0),
      objectNames: [],
    });
    expect(mesh.triangleCount).toBe(0);
    expect(issues.some((issue) => issue.code === 'empty-mesh' && issue.severity === 'error')).toBe(true);
  });

  it('keeps disjoint objects separate', () => {
    const { mesh } = conditionMesh(makeTwoCubes(2, 2));
    expect(mesh.vertexCount).toBe(16);
    expect(mesh.triangleCount).toBe(24);
    expect(Array.from(mesh.objectOfTriangle.slice(0, 12))).toEqual(new Array(12).fill(0));
    expect(Array.from(mesh.objectOfTriangle.slice(12))).toEqual(new Array(12).fill(1));
  });

  it('measures bounds and weld tolerance', () => {
    const bounds = boundsOf(new Float32Array([0, 0, 0, 2, 3, 6]));
    expect(bounds.diagonal).toBe(7);
    const positions = new Float32Array([0, 0, 0, 1e-6, 0, 0, 1, 0, 0]);
    expect(weldVertices(positions, 1e-3).positions.length / 3).toBe(2);
    expect(weldVertices(positions, 1e-9).positions.length / 3).toBe(3);
  });
});

describe('topology', () => {
  it('finds the boundary loop of an open plane', () => {
    const { mesh } = conditionMesh(makePlaneGrid(2, 2));
    const topology = buildTopology(mesh);
    const stats = topologyStats(topology);
    expect(mesh.triangleCount).toBe(8);
    expect(stats.boundaryEdges).toBe(8);
    expect(stats.nonManifoldEdges).toBe(0);
  });

  it('finds no boundary on a closed cube', () => {
    const { mesh } = conditionMesh(makeCube(2));
    const topology = buildTopology(mesh);
    expect(topology.boundaryEdges).toHaveLength(0);
    expect(topology.nonManifoldEdges).toHaveLength(0);
  });

  it('detects a non-manifold edge', () => {
    const { mesh } = conditionMesh(makeNonManifold());
    const topology = buildTopology(mesh);
    expect(topology.nonManifoldEdges).toHaveLength(1);
    expect(topology.edges[topology.nonManifoldEdges[0]].triangles).toHaveLength(3);
  });
});

describe('scene flattening', () => {
  function triangleGeometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setIndex([0, 1, 2]);
    return geometry;
  }

  it('applies world transforms and keeps object names', () => {
    const root = new Object3D();
    const mesh = new Mesh(triangleGeometry(), new MeshBasicMaterial());
    mesh.name = 'Triangle';
    mesh.position.set(1, 2, 3);
    root.add(mesh);
    const result = flattenScene(root);
    expect(result.mesh.indices).toHaveLength(3);
    expect(result.mesh.objectNames).toEqual(['Triangle']);
    expect(Array.from(result.mesh.positions)).toEqual([1, 2, 3, 2, 2, 3, 1, 3, 3]);
    expect(result.skipped).toEqual([]);
  });

  it('expands instances into separate object slots', () => {
    const root = new Object3D();
    const instances = new InstancedMesh(triangleGeometry(), new MeshBasicMaterial(), 2);
    instances.name = 'Instances';
    instances.setMatrixAt(0, new Matrix4());
    instances.setMatrixAt(1, new Matrix4().makeTranslation(5, 0, 0));
    root.add(instances);
    const result = flattenScene(root);
    expect(result.mesh.indices.length / 3).toBe(2);
    expect(Array.from(result.mesh.objectOfTriangle)).toEqual([0, 1]);
    expect(result.mesh.objectNames).toEqual(['Instances[0]', 'Instances[1]']);
    expect(result.mesh.positions[9]).toBe(5);
  });

  it('skips hidden meshes unless asked to include them', () => {
    const root = new Object3D();
    const mesh = new Mesh(triangleGeometry(), new MeshBasicMaterial());
    mesh.visible = false;
    root.add(mesh);
    expect(flattenScene(root).mesh.indices).toHaveLength(0);
    expect(flattenScene(root, { includeHidden: true }).mesh.indices).toHaveLength(3);
  });

  it('records material groups per triangle', () => {
    const geometry = triangleGeometry();
    geometry.addGroup(0, 3, 4);
    const root = new Object3D();
    root.add(new Mesh(geometry, new MeshBasicMaterial()));
    const result = flattenScene(root);
    expect(Array.from(result.mesh.materialOfTriangle)).toEqual([4]);
  });
});
