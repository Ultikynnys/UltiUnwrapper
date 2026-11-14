/** Mirrors a chart's U coordinate while preserving V. */
export function mirrorU(uvs: Float32Array): Float32Array {
  const mirrored = new Float32Array(uvs.length);
  for (let vertex = 0; vertex < uvs.length / 2; vertex += 1) {
    mirrored[vertex * 2] = -uvs[vertex * 2];
    mirrored[vertex * 2 + 1] = uvs[vertex * 2 + 1];
  }
  return mirrored;
}
