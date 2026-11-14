import {
  BufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Vector3,
} from 'three';
import type { RawMesh } from './unwrap/types';

export type FlattenResult = {
  mesh: RawMesh;
  /** Meshes that could not contribute geometry, with the reason. */
  skipped: Array<{ name: string; reason: string }>;
  meshCount: number;
  instanceCount: number;
};

type MaterialGroups = Int32Array;

function groupMaterials(geometry: BufferGeometry, triangleCount: number): MaterialGroups {
  const material = new Int32Array(triangleCount).fill(-1);
  for (let groupIndex = 0; groupIndex < geometry.groups.length; groupIndex += 1) {
    const group = geometry.groups[groupIndex];
    const start = Math.max(0, Math.floor(group.start / 3));
    const end = Math.min(triangleCount, Math.floor((group.start + group.count) / 3));
    const materialIndex = group.materialIndex ?? groupIndex;
    for (let tri = start; tri < end; tri += 1) material[tri] = materialIndex;
  }
  return material;
}

function effectivelyVisible(object: Object3D, root: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    if (current === root) break;
    current = current.parent;
  }
  return true;
}

/** Flattens every visible mesh in a scene into one world-space triangle mesh.
 * Instances contribute one object slot each, so instance boundaries remain
 * available to the seam stage. Materials and source triangle ids are kept for
 * reporting; textures and shading attributes are deliberately ignored. */
export function flattenScene(
  scene: Object3D,
  options: { includeHidden?: boolean } = {},
): FlattenResult {
  scene.updateMatrixWorld(true);
  const includeHidden = options.includeHidden ?? false;
  const positions: number[] = [];
  const indices: number[] = [];
  const objectOfTriangle: number[] = [];
  const materialOfTriangle: number[] = [];
  const sourceTriangle: number[] = [];
  const sourceVertex: number[] = [];
  const triangleUvs: number[] = [];
  const objectNames: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let meshCount = 0;
  let instanceCount = 0;
  let everyMeshHasUvs = true;

  const append = (geometry: BufferGeometry, matrix: Matrix4, name: string): void => {
    const position = geometry.getAttribute('position');
    if (!position) {
      skipped.push({ name, reason: 'Geometry has no position attribute.' });
      return;
    }
    const index = geometry.getIndex();
    const uv = geometry.getAttribute('uv');
    if (!uv) everyMeshHasUvs = false;
    const triangleCount = Math.floor((index ? index.count : position.count) / 3);
    if (triangleCount === 0) {
      skipped.push({ name, reason: 'Geometry has no triangles.' });
      return;
    }
    const material = groupMaterials(geometry, triangleCount);
    const objectIndex = objectNames.length;
    objectNames.push(name);
    const vertexOffset = positions.length / 3;
    const vertex = new Vector3();
    for (let i = 0; i < position.count; i += 1) {
      vertex.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(matrix);
      positions.push(vertex.x, vertex.y, vertex.z);
      sourceVertex.push(i);
    }
    for (let tri = 0; tri < triangleCount; tri += 1) {
      const base = tri * 3;
      const a = index ? index.getX(base) : base;
      const b = index ? index.getX(base + 1) : base + 1;
      const c = index ? index.getX(base + 2) : base + 2;
      indices.push(vertexOffset + a, vertexOffset + b, vertexOffset + c);
      if (uv) {
        triangleUvs.push(
          uv.getX(a), uv.getY(a),
          uv.getX(b), uv.getY(b),
          uv.getX(c), uv.getY(c),
        );
      } else {
        triangleUvs.push(0, 0, 0, 0, 0, 0);
      }
      objectOfTriangle.push(objectIndex);
      materialOfTriangle.push(material[tri]);
      sourceTriangle.push(tri);
    }
    instanceCount += 1;
  };

  scene.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    meshCount += 1;
    if (!includeHidden && !effectivelyVisible(child, scene)) return;
    const name = child.name || child.type || 'Mesh';
    if (child instanceof InstancedMesh) {
      const instanceMatrix = new Matrix4();
      const world = new Matrix4();
      for (let instance = 0; instance < child.count; instance += 1) {
        child.getMatrixAt(instance, instanceMatrix);
        world.multiplyMatrices(child.matrixWorld, instanceMatrix);
        append(child.geometry, world, `${name}[${instance}]`);
      }
      return;
    }
    append(child.geometry, child.matrixWorld, name);
  });

  return {
    mesh: {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      objectOfTriangle: new Uint32Array(objectOfTriangle),
      materialOfTriangle: new Int32Array(materialOfTriangle),
      sourceTriangle: new Uint32Array(sourceTriangle),
      sourceVertex: new Uint32Array(sourceVertex),
      ...(everyMeshHasUvs ? { triangleUvs: new Float32Array(triangleUvs) } : {}),
      objectNames,
    },
    skipped,
    meshCount,
    instanceCount,
  };
}
