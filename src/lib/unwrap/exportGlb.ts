import type { ExportMesh } from './exportMesh';

export type GlbOptions = {
  name?: string;
  version?: string;
  input?: string;
};

function align4(value: number): number {
  return (value + 3) & ~3;
}

function padTo(bytes: Uint8Array, length: number, fill: number): Uint8Array {
  if (bytes.length === length) return bytes;
  const padded = new Uint8Array(length);
  padded.fill(fill);
  padded.set(bytes);
  return padded;
}

function minMax(values: Float32Array, components: number): { min: number[]; max: number[] } {
  const min = new Array(components).fill(Infinity);
  const max = new Array(components).fill(-Infinity);
  for (let index = 0; index < values.length; index += components) {
    for (let component = 0; component < components; component += 1) {
      const value = values[index + component];
      if (value < min[component]) min[component] = value;
      if (value > max[component]) max[component] = value;
    }
  }
  if (values.length === 0) {
    min.fill(0);
    max.fill(0);
  }
  return { min, max };
}

/** Writes a geometry-only GLB 2.0 file with POSITION, NORMAL, TEXCOORD_0, and
 * 32-bit indices. Materials and textures are intentionally omitted. */
export function exportGlb(mesh: ExportMesh, options: GlbOptions = {}): Uint8Array {
  const positionBytes = new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength);
  const normalBytes = new Uint8Array(mesh.normals.buffer, mesh.normals.byteOffset, mesh.normals.byteLength);
  const uvBytes = new Uint8Array(mesh.uvs.buffer, mesh.uvs.byteOffset, mesh.uvs.byteLength);
  const indexBytes = new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength);

  const positionOffset = 0;
  const normalOffset = align4(positionOffset + positionBytes.length);
  const uvOffset = align4(normalOffset + normalBytes.length);
  const indexOffset = align4(uvOffset + uvBytes.length);
  const binaryLength = align4(indexOffset + indexBytes.length);
  const binary = new Uint8Array(binaryLength);
  binary.set(positionBytes, positionOffset);
  binary.set(normalBytes, normalOffset);
  binary.set(uvBytes, uvOffset);
  binary.set(indexBytes, indexOffset);

  const positionRange = minMax(mesh.positions, 3);
  const json = {
    asset: {
      version: '2.0',
      generator: `UltiUnwrapper ${options.version ?? 'dev'}`,
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: options.name ?? 'UltiUnwrapperMesh' }],
    meshes: [{
      name: options.name ?? 'UltiUnwrapperMesh',
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
        indices: 3,
        mode: 4,
      }],
    }],
    buffers: [{ byteLength: binaryLength }],
    bufferViews: [
      { buffer: 0, byteOffset: positionOffset, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: normalOffset, byteLength: normalBytes.length, target: 34962 },
      { buffer: 0, byteOffset: uvOffset, byteLength: uvBytes.length, target: 34962 },
      { buffer: 0, byteOffset: indexOffset, byteLength: indexBytes.length, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: mesh.cornerCount,
        type: 'VEC3',
        min: positionRange.min,
        max: positionRange.max,
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: mesh.cornerCount,
        type: 'VEC3',
      },
      {
        bufferView: 2,
        componentType: 5126,
        count: mesh.cornerCount,
        type: 'VEC2',
      },
      {
        bufferView: 3,
        componentType: 5125,
        count: mesh.indices.length,
        type: 'SCALAR',
      },
    ],
    extras: {
      triangleCount: mesh.triangleCount,
      cornerCount: mesh.cornerCount,
      input: options.input ?? null,
    },
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = padTo(jsonBytes, align4(jsonBytes.length), 0x20);
  const totalLength = 12 + 8 + jsonPadded.length + 8 + binary.length;
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.set(jsonPadded, 20);
  const binaryChunkStart = 20 + jsonPadded.length;
  view.setUint32(binaryChunkStart, binary.length, true);
  view.setUint32(binaryChunkStart + 4, 0x004e4942, true);
  output.set(binary, binaryChunkStart + 8);
  return output;
}
