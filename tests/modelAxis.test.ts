import { afterEach, describe, expect, it, vi } from 'vitest';
import { upAxisRotation, withoutFbxUpAxisWarning } from '../src/lib/modelAxis';

describe('upAxisRotation', () => {
  it('maps a Z-up source into the app Y-up world', () => {
    expect(upAxisRotation('blender')).toBe(-Math.PI / 2);
    expect(upAxisRotation('maya')).toBe(0);
  });

  it('suppresses only the FBXLoader up-axis notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await withoutFbxUpAxisWarning(async () => {
      console.warn('FBXLoader: Z-UP coordinate system detected.');
      console.warn('unrelated warning');
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('unrelated warning');
    warn.mockRestore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
