import { LoadingManager, Object3D } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { upAxisRotation, withoutFbxUpAxisWarning } from './modelAxis';
import type { ModelFileBundle, WorldAxis } from './modelFiles';

/** Loads the primary model from an uploaded file bundle, resolving companion
 * textures through the bundle's object URLs. FBX and OBJ carry a world-axis
 * assumption; glTF and GLB are always Y-up and must not be rotated. */
export async function loadModelFromBundle(
  bundle: ModelFileBundle,
  worldAxis: WorldAxis = 'blender',
): Promise<Object3D> {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => bundle.manager.resolveURL(url));

  let scene: Object3D;
  switch (bundle.format) {
    case 'fbx':
      scene = await withoutFbxUpAxisWarning(() => new FBXLoader(manager).loadAsync(bundle.primaryUrl));
      break;
    case 'obj':
      scene = await new OBJLoader(manager).loadAsync(bundle.primaryUrl);
      break;
    case 'gltf':
    case 'glb': {
      const gltf = await new GLTFLoader(manager).loadAsync(bundle.primaryUrl);
      scene = gltf.scene;
      break;
    }
    case 'usdz':
      throw new Error('USDZ needs a WASM reader that this build does not bundle. Convert to GLB or FBX.');
    default:
      throw new Error(`Unsupported model format ".${bundle.format}".`);
  }
  if (bundle.format === 'fbx' || bundle.format === 'obj') {
    scene.rotation.set(upAxisRotation(worldAxis), 0, 0);
  }
  scene.updateMatrixWorld(true);
  return scene;
}
