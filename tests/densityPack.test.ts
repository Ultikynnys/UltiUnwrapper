import { describe, expect, it } from 'vitest';
import { computeFaceGeometry, conditionMesh } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import { segmentMesh } from '../src/lib/unwrap/charts';
import { parameterizeMesh } from '../src/lib/unwrap/parameterize';
import { normalizeDensity } from '../src/lib/unwrap/density';
import { packAtlas, type PackOptions } from '../src/lib/unwrap/pack';
import type { ChartPlacement, DensityOptions, RawMesh } from '../src/lib/unwrap/types';
import { makeCube, makeCylinder, rawMesh } from './helpers/meshes';

const densityDefaults: DensityOptions = {
  atlasResolution: 2048,
  targetTexelDensity: 256,
};

const packDefaults: PackOptions = {
  atlasResolution: 2048,
  padding: 8,
  allowRotation: true,
  targetTexelDensity: 256,
};

function prepare(raw: RawMesh, densityOptions: Partial<DensityOptions> = {}) {
  const { mesh } = conditionMesh(raw);
  const topology = buildTopology(mesh);
  const face = computeFaceGeometry(mesh);
  const segmentation = segmentMesh(mesh, topology, face, {
    seamAngle: 66,
    splitByObject: true,
    splitByMaterial: false,
  });
  const parameterization = parameterizeMesh(mesh, segmentation, face, topology);
  const densityOptionsResolved = { ...densityDefaults, ...densityOptions };
  const density = normalizeDensity(mesh, parameterization, face, densityOptionsResolved);
  return { mesh, topology, face, segmentation, parameterization, density, densityOptionsResolved };
}

function run(raw: RawMesh, densityOptions: Partial<DensityOptions> = {}, packOptions: Partial<PackOptions> = {}) {
  const prepared = prepare(raw, densityOptions);
  const packOptionsResolved = {
    ...packDefaults,
    atlasResolution: prepared.densityOptionsResolved.atlasResolution,
    targetTexelDensity: prepared.densityOptionsResolved.targetTexelDensity,
    ...packOptions,
  };
  const pack = packAtlas(prepared.mesh, prepared.density, prepared.face, packOptionsResolved);
  return { ...prepared, pack };
}

function makeDisconnectedTriangles(count: number): RawMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = positions.length / 3;
    positions.push(index * 3, 0, 0, index * 3 + 1, 0, 0, index * 3, 1, 0);
    indices.push(base, base + 1, base + 2);
  }
  return rawMesh(positions, indices);
}

function overlaps(a: ChartPlacement, b: ChartPlacement): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

describe('texel density normalization', () => {
  it('equalizes cube chart density at a target that fits', () => {
    const { density, parameterization } = run(makeCube(2));
    expect(density.charts).toHaveLength(6);
    expect(density.stats.requiredAreaFraction).toBeCloseTo(0.375, 5);
    expect(density.stats.densityBeforeSpread).toBeCloseTo(0, 6);
    expect(density.stats.densityAfterSpread).toBeCloseTo(0, 6);
    expect(density.stats.targetDensity).toBe(256);
    expect(density.stats.densityP50).toBeCloseTo(256, 3);
    expect(Array.from(density.chartScales)).toEqual(new Array(6).fill(0.125));
    for (const chart of density.charts) {
      expect(chart.uvArea).toBeCloseTo(0.0625, 6);
    }
    for (let face = 0; face < density.faceTexelDensity.length; face += 1) {
      expect(density.faceTexelDensity[face]).toBeCloseTo(256, 3);
      expect(density.densityRatio[face]).toBeCloseTo(1, 5);
    }
    expect(parameterization.charts.every((chart) => chart.failed === false)).toBe(true);
  });

  it('warns when the target density needs more than one atlas', () => {
    const { density } = prepare(makeCube(2), { targetTexelDensity: 512 });
    expect(density.stats.requiredAreaFraction).toBeCloseTo(1.5, 5);
    expect(density.issues.some((issue) => issue.code === 'target-density-does-not-fit')).toBe(true);
    expect(density.stats.densityP50).toBeCloseTo(512, 3);
  });

  it('equalizes the different cylinder charts', () => {
    const { density } = run(makeCylinder(12, 1, 2));
    expect(density.charts).toHaveLength(3);
    expect(density.stats.densityAfterSpread).toBeLessThan(1e-5);
    expect(density.stats.densityP50).toBeCloseTo(256, 3);
    for (const chart of density.charts) {
      expect(chart.uvArea).toBeGreaterThan(0);
    }
  });

  it('reports a non-positive atlas or target', () => {
    const { density } = prepare(makeCube(2), { atlasResolution: 0, targetTexelDensity: 0 });
    expect(density.issues.some((issue) => issue.code === 'invalid-density')).toBe(true);
    expect(density.stats.targetDensity).toBe(0);
  });

  it('reports chart scales clamped by the density limits', () => {
    const { density } = prepare(makeCube(2), { minChartScale: 1 });
    expect(density.issues.some((issue) => issue.code === 'density-clamped')).toBe(true);
    expect(density.stats.clampedCharts).toBe(6);
    expect(density.stats.scaleMin).toBe(1);
  });
});

describe('atlas packing', () => {
  it('places every cube chart without overlap or padding loss', () => {
    const { pack } = run(makeCube(2));
    expect(pack.charts).toHaveLength(6);
    expect(pack.placements).toHaveLength(6);
    expect(pack.scale).toBe(1);
    expect(pack.achievedTexelDensity).toBeCloseTo(256, 3);
    expect(pack.occupancy).toBeCloseTo(0.375, 2);
    expect(typeof pack.stats.rotatedCharts).toBe('number');

    for (const placement of pack.placements) {
      expect(placement.x).toBeGreaterThanOrEqual(8);
      expect(placement.y).toBeGreaterThanOrEqual(8);
      expect(placement.x + placement.width).toBeLessThanOrEqual(2048 - 8);
      expect(placement.y + placement.height).toBeLessThanOrEqual(2048 - 8);
    }
    for (let i = 0; i < pack.placements.length; i += 1) {
      for (let j = i + 1; j < pack.placements.length; j += 1) {
        expect(overlaps(pack.placements[i], pack.placements[j])).toBe(false);
      }
    }
    for (const value of pack.triangleUvs) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('grows every chart uniformly when filling the atlas', () => {
    const { pack } = run(makeCube(2), {}, { fitToAtlas: true });
    expect(pack.scale).toBeGreaterThan(1);
    expect(pack.achievedTexelDensity).toBeGreaterThan(256);
    expect(pack.occupancy).toBeGreaterThan(0.5);
    expect(pack.issues.some((issue) => issue.code === 'density-increased')).toBe(true);
    const original = run(makeCube(2));
    expect(pack.achievedTexelDensity).toBeGreaterThan(original.pack.achievedTexelDensity);
  });

  it('throws when the target density does not fit the atlas', () => {
    expect(() => run(makeCube(2), { targetTexelDensity: 512 }, { targetTexelDensity: 512 }))
      .toThrow(/Concave packing could not place/);
  });

  it('packs the cylinder charts deterministically', () => {
    const first = run(makeCylinder(12, 1, 2)).pack;
    const second = run(makeCylinder(12, 1, 2)).pack;
    expect(first.placements).toEqual(second.placements);
    expect(Array.from(first.triangleUvs)).toEqual(Array.from(second.triangleUvs));
    expect(first.placements).toHaveLength(3);
  });

  it('throws when padding leaves no atlas room', () => {
    expect(() => run(makeCube(2), { atlasResolution: 64 }, { atlasResolution: 64, padding: 32 }))
      .toThrow(/leaves no room/);
  });

  it('warns when a valid layout still has low occupancy', () => {
    const { pack } = run(makeCube(2), {}, { minOccupancy: 0.99 });
    expect(pack.placements).toHaveLength(6);
    expect(pack.issues.some((issue) => issue.code === 'low-occupancy')).toBe(true);
  });

  it('throws when the charts do not fit the atlas', () => {
    expect(() => run(
      makeDisconnectedTriangles(20),
      { atlasResolution: 16 },
      { atlasResolution: 16, padding: 4 },
    )).toThrow(/Concave packing could not place/);
  });
});
