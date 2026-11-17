import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { BufferGeometry, Mesh, Object3D } from 'three';
import { DEFAULT_CONFIG } from '../src/lib/unwrap/config';
import { runUnwrap } from '../src/lib/unwrap/pipeline';
import { buildExportMesh } from '../src/lib/unwrap/exportMesh';
import { exportGlb } from '../src/lib/unwrap/exportGlb';
import { exportObj } from '../src/lib/unwrap/exportObj';
import { makeCube } from './helpers/meshes';

let cubeCache: { result: Awaited<ReturnType<typeof runUnwrap>>; mesh: ReturnType<typeof buildExportMesh> } | null = null;

async function cubeExport() {
  if (!cubeCache) {
    const result = await runUnwrap(makeCube(2), DEFAULT_CONFIG);
    cubeCache = { result, mesh: buildExportMesh(result.mesh, result.pack.triangleUvs) };
  }
  return cubeCache;
}

function parseGlb(bytes: Uint8Array): Promise<Object3D> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', (gltf) => resolve(gltf.scene), reject);
  });
}

describe('mesh export', () => {
  it('expands the cube into one corner per triangle vertex', async () => {
    const { mesh } = await cubeExport();
    expect(mesh.cornerCount).toBe(36);
    expect(mesh.triangleCount).toBe(12);
    expect(mesh.indices).toHaveLength(36);
    expect(mesh.groups).toEqual([{ name: 'Cube', start: 0, count: 36 }]);
    expect(mesh.uvs).toHaveLength(72);
  });

  it('round-trips through OBJLoader', async () => {
    const { mesh } = await cubeExport();
    const text = exportObj(mesh, { name: 'Cube', version: 'test', input: 'cube.obj' });
    expect(text).toContain('g Cube');
    expect(text).toContain('vt ');
    expect(text).toContain('vn ');
    const parsed = new OBJLoader().parse(text);
    let geometry: BufferGeometry | null = null;
    parsed.traverse((child) => {
      if ((child as Mesh).isMesh && !geometry) geometry = (child as Mesh).geometry;
    });
    expect(geometry).not.toBeNull();
    const position = geometry!.getAttribute('position');
    const uv = geometry!.getAttribute('uv');
    const normal = geometry!.getAttribute('normal');
    const index = geometry!.getIndex();
    expect(position.count).toBe(36);
    expect(uv.count).toBe(36);
    expect(normal.count).toBe(36);
    expect((index ? index.count : position.count) / 3).toBe(12);
  });

  it('round-trips through GLTFLoader', async () => {
    const { mesh } = await cubeExport();
    const bytes = exportGlb(mesh, { name: 'Cube', version: 'test', input: 'cube.obj' });
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(bytes.length);

    const scene = await parseGlb(bytes);
    let geometry: BufferGeometry | null = null;
    scene.traverse((child) => {
      if ((child as Mesh).isMesh && !geometry) geometry = (child as Mesh).geometry;
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.getAttribute('position').count).toBe(36);
    expect(geometry!.getAttribute('uv').count).toBe(36);
    expect(geometry!.getAttribute('normal').count).toBe(36);
    expect(geometry!.getIndex()!.count).toBe(36);
  });

  it('is deterministic', async () => {
    const { mesh } = await cubeExport();
    expect(exportObj(mesh, { name: 'Cube', version: 'test' })).toBe(exportObj(mesh, { name: 'Cube', version: 'test' }));
    expect(exportGlb(mesh, { name: 'Cube', version: 'test' })).toEqual(exportGlb(mesh, { name: 'Cube', version: 'test' }));
  });
});
