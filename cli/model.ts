/**
 * Headless model loading for the CLI. three.js loaders are driven through
 * their `parse()` entry points on fs-read buffers, so no File, URL, or fetch is
 * involved. FBX, OBJ, glTF, and GLB are supported; USDZ needs a WASM reader and
 * reports a clear error.
 */
import { ImageLoader, Object3D, Texture } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { cliHost } from './host';
import { extname } from './path';

let textureStubInstalled = false;

/** Loaders reach for the DOM `document` to decode images, which does not exist
 * in Node. Unwrapping needs geometry only, so intercept ImageLoader and hand
 * back an empty texture instead of decoding. */
function stubTextureLoading(): void {
  if (textureStubInstalled) return;
  textureStubInstalled = true;
  ImageLoader.prototype.load = function stubLoad(
    _url: string,
    onLoad?: (image: HTMLImageElement) => void,
  ) {
    const texture = new Texture();
    onLoad?.(texture as unknown as HTMLImageElement);
    return texture as unknown as HTMLImageElement;
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function loadModel(path: string): Promise<Object3D> {
  const extension = extname(path).toLowerCase().replace('.', '');
  const bytes = await cliHost().readFileBytes(path);
  const baseDir = path.replace(/\\/g, '/').replace(/[^/]*$/, '');
  stubTextureLoading();

  switch (extension) {
    case 'fbx':
      return new FBXLoader().parse(toArrayBuffer(bytes), baseDir);
    case 'obj':
      return new OBJLoader().parse(new TextDecoder().decode(bytes));
    case 'glb':
    case 'gltf':
      return await new Promise<Object3D>((resolve, reject) => {
        new GLTFLoader().parse(
          toArrayBuffer(bytes),
          baseDir,
          (result) => resolve(result.scene),
          reject,
        );
      });
    case 'usdz':
      throw new Error('USDZ models need a WASM reader that the headless CLI does not bundle. Convert to GLB/FBX.');
    default:
      throw new Error(`Unsupported model format ".${extension}". Supported: fbx, obj, gltf, glb.`);
  }
}
