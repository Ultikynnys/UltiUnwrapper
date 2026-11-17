import { afterEach, describe, expect, it } from 'vitest';
import { conditionMesh, computeFaceGeometry } from '../src/lib/unwrap/mesh';
import { buildTopology } from '../src/lib/unwrap/topology';
import {
  buildSmartIslandBase,
  projectSmart,
  type RefineRunnerInput,
} from '../src/lib/unwrap/smartProject';
import { nowEpoch } from '../src/lib/unwrap/clock';
import { createNodeRefineRunner, resolveRefineThreads } from '../cli/refinePoolNode';
import { makeSphere } from './helpers/meshes';

const pools: Array<{ dispose: () => void }> = [];

afterEach(() => {
  for (const pool of pools) pool.dispose();
  pools.length = 0;
});

describe('refinement thread pool', () => {
  it('resolves explicit and automatic thread counts', () => {
    expect(resolveRefineThreads(1, 8)).toBe(1);
    expect(resolveRefineThreads(4, 8)).toBe(4);
    expect(resolveRefineThreads(99, 8)).toBe(8);
    const auto = resolveRefineThreads(0, 8);
    expect(auto).toBeGreaterThanOrEqual(1);
    expect(auto).toBeLessThanOrEqual(4);
  });

  it('refines a sphere across worker threads', async () => {
    const { mesh } = conditionMesh(makeSphere(20, 10, 1));
    const topology = buildTopology(mesh);
    const face = computeFaceGeometry(mesh);
    const projection = projectSmart(mesh, face, { angleLimit: 66, areaWeight: 0 });
    const base = buildSmartIslandBase(mesh, topology, face, projection, {
      splitByObject: true,
      splitByMaterial: false,
      maxDensitySpread: 0.1,
    });
    const input: RefineRunnerInput = {
      mesh,
      topology,
      face,
      variants: [{
        id: 'test',
        label: 'test',
        base,
        cutStrategies: 5,
      }],
      deadline: nowEpoch() + 2_000,
      budgetMs: 2_000,
    };
    const pool = createNodeRefineRunner(2);
    pools.push(pool);
    const outcome = await pool.runner(input);
    expect(outcome.layout.chartCount).toBeGreaterThan(0);
    expect(outcome.wasmTasks).toBeGreaterThan(0);
    expect(outcome.refineRestarts).toBeGreaterThan(0);
    expect(outcome.densityUnresolved).toBe(0);
    expect(outcome.refineTimeMs).toBeGreaterThan(0);
  });
});
