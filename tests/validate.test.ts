import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../src/lib/unwrap/config';
import { runUnwrap } from '../src/lib/unwrap/pipeline';
import { validateUnwrap } from '../src/lib/unwrap/validate';
import { makeCube, makeCylinder, makeSphere } from './helpers/meshes';

const options = { ...DEFAULT_CONFIG.thresholds, occupancyResolution: 512 };
const base = mergeConfig(DEFAULT_CONFIG, { method: 'lscm' });

describe('validation', () => {
  it('passes a clean cube and reports no weaknesses', async () => {
    const result = await runUnwrap(makeCube(2), base);
    expect(result.validation.status).toBe('pass');
    expect(result.validation.stats.overlapFraction).toBe(0);
    expect(result.validation.stats.flipped).toBe(0);
    expect(result.validation.stats.densitySpread).toBeLessThan(1e-6);
    expect(result.validation.topWeaknesses).toEqual([]);
    expect(result.validation.overlapMask).toHaveLength(1024 * 1024);
    expect(result.validation.overlapWidth).toBe(1024);
  });

  it('fits the atlas when the target density needs more than one atlas', async () => {
    const config = mergeConfig(base, { targetTexelDensity: 512 });
    const result = await runUnwrap(makeCube(2), config);
    expect(result.pack.scale).toBeLessThan(1);
    expect(result.pack.achievedTexelDensity).toBeLessThan(512);
    expect(result.pack.issues.some((issue) => issue.code === 'density-fitted')).toBe(true);
    expect(result.pack.placements).toHaveLength(6);
  });

  it('fails loudly when fitToAtlas is disabled and the target does not fit', async () => {
    const config = mergeConfig(base, { targetTexelDensity: 512, fitToAtlas: false });
    await expect(runUnwrap(makeCube(2), config)).rejects.toThrow(/Concave packing could not place/);
  });

  it('passes a cylinder when every chart has room at the target density', async () => {
    const config = mergeConfig(base, { targetTexelDensity: 300 });
    const result = await runUnwrap(makeCylinder(12, 1, 2), config);
    expect(result.validation.status).toBe('pass');
    expect(result.validation.stats.angleP95).toBeLessThan(1);
    expect(result.validation.stats.densitySpread).toBeLessThan(1e-5);
    expect(result.validation.stats.overlapFraction).toBe(0);
  });

  it('exposes the area-driven density weakness of a cut sphere', async () => {
    const config = mergeConfig(base, { targetTexelDensity: 512, atlasResolution: 4096 });
    const result = await runUnwrap(makeSphere(12, 6, 1), config);
    expect(result.validation.status).toBe('error');
    expect(result.validation.stats.angleP95).toBeLessThan(20);
    expect(result.validation.stats.flipped).toBe(0);
    expect(result.validation.stats.densitySpread).toBeGreaterThan(0.1);
    expect(result.validation.weaknesses.some((weakness) => weakness.kind === 'density')).toBe(true);
  });

  it('warns about weak charts without failing the numeric thresholds', async () => {
    const config = mergeConfig(base, {
      targetTexelDensity: 512,
      atlasResolution: 4096,
      thresholds: {
        maxOverlapFraction: 1,
        maxAngleP95: 180,
        maxDensitySpread: 100,
        maxFlipped: 1_000_000,
        minOccupancy: 0,
      },
    });
    const result = await runUnwrap(makeSphere(12, 6, 1), config);
    expect(result.validation.topWeaknesses.some((weakness) => weakness.kind === 'area')).toBe(true);
    expect(result.validation.issues.some((issue) => issue.code === 'weak-charts')).toBe(true);
    expect(result.validation.status).toBe('warn');
  });

  it('falls back to a 2048 atlas when pack stats omit the resolution', async () => {
    const result = await runUnwrap(makeCube(2), base);
    const stats = { ...result.pack.stats };
    delete stats.atlasResolution;
    const validation = validateUnwrap(
      result.mesh,
      result.parameterization,
      { ...result.pack, stats },
      options,
    );
    expect(validation.stats.validationResolution).toBe(512);
  });

  it('fails overlapping UVs', async () => {
    const result = await runUnwrap(makeCube(2), base);
    const triangleUvs = new Float32Array(result.pack.triangleUvs.length);
    for (let triangle = 0; triangle < result.mesh.triangleCount; triangle += 1) {
      triangleUvs[triangle * 6] = 0;
      triangleUvs[triangle * 6 + 1] = 0;
      triangleUvs[triangle * 6 + 2] = 1;
      triangleUvs[triangle * 6 + 3] = 0;
      triangleUvs[triangle * 6 + 4] = 1;
      triangleUvs[triangle * 6 + 5] = 1;
    }
    const pack = {
      ...result.pack,
      triangleUvs,
      stats: { ...result.pack.stats, atlasResolution: 256 },
    };
    const validation = validateUnwrap(result.mesh, result.parameterization, pack, options);
    expect(validation.status).toBe('error');
    expect(validation.stats.overlapFraction).toBeGreaterThan(0.9);
    expect(validation.weaknesses.some((weakness) => weakness.kind === 'overlap')).toBe(true);
    expect(validation.faceOverlap.some((value) => value === 1)).toBe(true);
  });

  it('fails flipped triangles', async () => {
    const result = await runUnwrap(makeCube(2), base);
    const parameterization = {
      ...result.parameterization,
      flipped: new Uint8Array(result.parameterization.flipped.length).fill(1),
    };
    const validation = validateUnwrap(result.mesh, parameterization, result.pack, options);
    expect(validation.status).toBe('error');
    expect(validation.stats.flipped).toBe(result.mesh.triangleCount);
    expect(validation.issues.some((issue) => issue.code === 'flipped-above-threshold')).toBe(true);
  });

  it('fails uneven texel density', async () => {
    const result = await runUnwrap(makeCube(2), base);
    const faceTexelDensity = new Float32Array(result.pack.faceTexelDensity.length);
    for (let triangle = 0; triangle < faceTexelDensity.length; triangle += 1) {
      faceTexelDensity[triangle] = triangle % 2 === 0 ? 100 : 200;
    }
    const pack = { ...result.pack, faceTexelDensity };
    const validation = validateUnwrap(result.mesh, result.parameterization, pack, options);
    expect(validation.status).toBe('error');
    expect(validation.stats.densitySpread).toBeCloseTo(1, 6);
    expect(validation.issues.some((issue) => issue.code === 'density-spread-above-threshold')).toBe(true);
  });

  it('fails a sphere when the angle threshold is tightened', async () => {
    const config = mergeConfig(base, {
      targetTexelDensity: 512,
      atlasResolution: 4096,
      thresholds: { ...DEFAULT_CONFIG.thresholds, maxAngleP95: 1 },
    });
    const result = await runUnwrap(makeSphere(12, 6, 1), config);
    expect(result.validation.status).toBe('error');
    expect(result.validation.weaknesses.some((weakness) => weakness.kind === 'angle')).toBe(true);
  });
});
