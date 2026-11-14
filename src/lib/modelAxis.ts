import type { WorldAxis } from './modelFiles';

/** Up-axis correction: Blender is Z-up (rotate -90 degrees about X), Maya is Y-up. */
export function upAxisRotation(worldAxis: WorldAxis): number {
  return worldAxis === 'blender' ? -Math.PI / 2 : 0;
}

/** Runs `load` with the three.js FBXLoader Z-up notice suppressed: the loader
 * warns and rotates the root, and the caller immediately overwrites that
 * rotation. Only that one message is filtered. */
export async function withoutFbxUpAxisWarning<T>(load: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = ((...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.includes('Z-UP coordinate system')) return;
    original(...args);
  }) as typeof console.warn;
  try {
    return await load();
  } finally {
    console.warn = original;
  }
}
