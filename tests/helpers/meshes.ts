import type { RawMesh } from '../../src/lib/unwrap/types';

export function rawMesh(
  positions: number[],
  indices: number[],
  objectNames: string[] = ['Mesh'],
): RawMesh {
  const triangleCount = indices.length / 3;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    objectOfTriangle: new Uint32Array(triangleCount),
    materialOfTriangle: new Int32Array(triangleCount).fill(-1),
    sourceTriangle: new Uint32Array(Array.from({ length: triangleCount }, (_, i) => i)),
    sourceVertex: new Uint32Array(Array.from({ length: positions.length / 3 }, (_, i) => i)),
    objectNames,
  };
}

export function makePlaneGrid(segments = 2, size = 2): RawMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const step = size / segments;
  const half = size / 2;
  for (let row = 0; row <= segments; row += 1) {
    for (let column = 0; column <= segments; column += 1) {
      positions.push(-half + column * step, 0, -half + row * step);
    }
  }
  const stride = segments + 1;
  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const a = row * stride + column;
      const b = row * stride + column + 1;
      const c = (row + 1) * stride + column + 1;
      const d = (row + 1) * stride + column;
      indices.push(a, c, b, a, d, c);
    }
  }
  return rawMesh(positions, indices, ['Plane']);
}

export function makeCube(size = 2): RawMesh {
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
  return rawMesh(positions, indices, ['Cube']);
}

/** One cube whose faces do not share vertices; welding should recover 8. */
export function makeSplitCube(size = 2): RawMesh {
  const h = size / 2;
  const faces = [
    [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]],
    [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]],
    [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]],
    [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]],
    [[-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h]],
    [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const point of face) positions.push(point[0], point[1], point[2]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return rawMesh(positions, indices, ['Split cube']);
}

export function makeCylinder(segments = 12, radius = 1, height = 2): RawMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const half = height / 2;
  for (let i = 0; i < segments; i += 1) {
    const theta = (i / segments) * Math.PI * 2;
    positions.push(Math.cos(theta) * radius, -half, Math.sin(theta) * radius);
  }
  for (let i = 0; i < segments; i += 1) {
    const theta = (i / segments) * Math.PI * 2;
    positions.push(Math.cos(theta) * radius, half, Math.sin(theta) * radius);
  }
  const bottomCenter = positions.length / 3;
  positions.push(0, -half, 0);
  const topCenter = positions.length / 3;
  positions.push(0, half, 0);

  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % segments;
    const b0 = i;
    const b1 = j;
    const t0 = segments + i;
    const t1 = segments + j;
    indices.push(b0, t0, t1, b0, t1, b1);
    indices.push(topCenter, t1, t0);
    indices.push(bottomCenter, b0, b1);
  }
  return rawMesh(positions, indices, ['Cylinder']);
}

export function makeSphere(segments = 12, rings = 6, radius = 1): RawMesh {
  const positions: number[] = [0, radius, 0];
  for (let ring = 1; ring < rings; ring += 1) {
    const phi = (Math.PI * ring) / rings;
    for (let segment = 0; segment < segments; segment += 1) {
      const theta = (Math.PI * 2 * segment) / segments;
      positions.push(
        Math.sin(phi) * Math.cos(theta) * radius,
        Math.cos(phi) * radius,
        Math.sin(phi) * Math.sin(theta) * radius,
      );
    }
  }
  const south = positions.length / 3;
  positions.push(0, -radius, 0);
  const ringIndex = (ring: number, segment: number): number =>
    1 + (ring - 1) * segments + (segment % segments);
  const indices: number[] = [];

  for (let segment = 0; segment < segments; segment += 1) {
    const a = ringIndex(1, segment);
    const b = ringIndex(1, segment + 1);
    indices.push(0, b, a);
  }
  for (let ring = 1; ring < rings - 1; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ringIndex(ring, segment);
      const b = ringIndex(ring, segment + 1);
      const c = ringIndex(ring + 1, segment + 1);
      const d = ringIndex(ring + 1, segment);
      indices.push(a, b, c, a, c, d);
    }
  }
  for (let segment = 0; segment < segments; segment += 1) {
    const a = ringIndex(rings - 1, segment);
    const b = ringIndex(rings - 1, segment + 1);
    indices.push(a, b, south);
  }
  return rawMesh(positions, indices, ['Sphere']);
}

export function mergeRawMeshes(meshes: RawMesh[], names: string[]): RawMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const objectOfTriangle: number[] = [];
  const materialOfTriangle: number[] = [];
  const sourceTriangle: number[] = [];
  const sourceVertex: number[] = [];
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
    const mesh = meshes[meshIndex];
    const triangleCount = mesh.indices.length / 3;
    const vertexCount = mesh.positions.length / 3;
    const vertexOffset = positions.length / 3;
    for (const value of mesh.positions) positions.push(value);
    for (let tri = 0; tri < triangleCount; tri += 1) {
      indices.push(
        mesh.indices[tri * 3] + vertexOffset,
        mesh.indices[tri * 3 + 1] + vertexOffset,
        mesh.indices[tri * 3 + 2] + vertexOffset,
      );
      objectOfTriangle.push(meshIndex);
      materialOfTriangle.push(mesh.materialOfTriangle[tri] ?? -1);
      sourceTriangle.push(mesh.sourceTriangle[tri] ?? tri);
    }
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      sourceVertex.push(mesh.sourceVertex[vertex] ?? vertex);
    }
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    objectOfTriangle: new Uint32Array(objectOfTriangle),
    materialOfTriangle: new Int32Array(materialOfTriangle),
    sourceTriangle: new Uint32Array(sourceTriangle),
    sourceVertex: new Uint32Array(sourceVertex),
    objectNames: names,
  };
}

export function makeTwoCubes(size = 2, gap = 2): RawMesh {
  const first = makeCube(size);
  const second = makeCube(size);
  for (let i = 0; i < second.positions.length; i += 3) {
    second.positions[i] += size + gap;
  }
  return mergeRawMeshes([first, second], ['Cube A', 'Cube B']);
}

export function makeNonManifold(): RawMesh {
  return rawMesh(
    [
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, -1, 0,
      0, 0, 1,
    ],
    [0, 1, 2, 1, 0, 3, 0, 1, 4],
    ['Non-manifold'],
  );
}

export function makeDegenerate(): RawMesh {
  return rawMesh(
    [
      0, 0, 0,
      1, 0, 0,
      2, 0, 0,
      0, 1, 0,
    ],
    [0, 1, 2, 0, 1, 3],
    ['Degenerate'],
  );
}
