import { describe, expect, it } from 'vitest';
import { conditionMesh, computeFaceGeometry } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import { detectSymmetry } from '../src/lib/unwrap/symmetry';
import {
  buildSmartIslandBase,
  buildSmartIslands,
  projectSmart,
  refineChartsByDensity,
} from '../src/lib/unwrap/smartProject';
import { nowEpoch } from '../src/lib/unwrap/clock';
import { makePlaneGrid } from './helpers/meshes';

function prepare() {
  const { mesh } = conditionMesh(makePlaneGrid(4, 2));
  const topology = buildTopology(mesh);
  const face = computeFaceGeometry(mesh);
  const projection = projectSmart(mesh, face, { angleLimit: 66, areaWeight: 0 });
  const symmetry = detectSymmetry(mesh, topology);
  return { mesh, topology, face, projection, symmetry };
}

describe('mirror-aware islands', () => {
  it('turns on-plane edges into chart seams before growth', () => {
    const { mesh, topology, face, projection, symmetry } = prepare();
    const symmetric = buildSmartIslandBase(mesh, topology, face, projection, {
      splitByObject: true,
      splitByMaterial: false,
      symmetry,
    });
    const plain = buildSmartIslandBase(mesh, topology, face, projection, {
      splitByObject: true,
      splitByMaterial: false,
    });
    expect(symmetric.symmetrySeams).toBeGreaterThan(0);
    expect(symmetric.baseCharts.length).toBeGreaterThan(plain.baseCharts.length);
    expect(symmetric.mirrorPlane).toBe(symmetry.plane);
  });

  it('cuts a chart along the mirror plane with strategy 5', () => {
    const { mesh, topology, face, projection, symmetry } = prepare();
    const base = buildSmartIslandBase(mesh, topology, face, projection, {
      splitByObject: true,
      splitByMaterial: false,
    });
    expect(base.baseCharts).toHaveLength(1);
    const deadline = nowEpoch() + 2000;
    const refined = refineChartsByDensity(
      base.baseCharts,
      mesh,
      face,
      base.neighbors,
      base.tolerance,
      5,
      deadline,
      symmetry.plane,
    );
    expect(refined.charts.length).toBeGreaterThan(1);
    expect(refined.splits).toBeGreaterThanOrEqual(1);
    expect(refined.timedOut).toBe(false);
    const positive = refined.charts.filter((chart) => {
      let sum = 0;
      for (const triangle of chart.triangles) {
        for (let corner = 0; corner < 3; corner += 1) {
          const vertex = mesh.indices[triangle * 3 + corner];
          sum += mesh.positions[vertex * 3];
        }
      }
      return sum >= 0;
    });
    expect(positive.length).toBeGreaterThan(0);
    expect(positive.length).toBeLessThan(refined.charts.length);
  });

  it('includes a mirror variant in the smart island portfolio', async () => {
    const { mesh, topology, face, projection } = prepare();
    const islands = await buildSmartIslands(mesh, topology, face, projection, {
      splitByObject: true,
      splitByMaterial: false,
      maxDensitySpread: 0.1,
      budgetMs: 1000,
    });
    expect(Number(islands.stats.strategyVariants)).toBeGreaterThan(2);
    expect(Number(islands.stats.mirrorPlaneScore)).toBeGreaterThan(0);
    expect(Number(islands.stats.mirrorDetectedSeams)).toBeGreaterThan(0);
    expect(String(islands.stats.bestVariant).length).toBeGreaterThan(0);
    expect(islands.charts.length).toBeGreaterThan(0);
  });

  it('does not split when no mirror plane is supplied', () => {
    const { mesh, topology, face, projection, symmetry } = prepare();
    const base = buildSmartIslandBase(mesh, topology, face, projection, {
      splitByObject: true,
      splitByMaterial: false,
    });
    const refined = refineChartsByDensity(
      base.baseCharts,
      mesh,
      face,
      base.neighbors,
      base.tolerance,
      5,
      nowEpoch() + 2000,
      null,
    );
    expect(refined.charts).toHaveLength(1);
    expect(symmetry.plane).not.toBeNull();
  });
});
