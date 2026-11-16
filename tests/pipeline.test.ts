import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/unwrap/config';
import { runUnwrap } from '../src/lib/unwrap/pipeline';
import { makeCube } from './helpers/meshes';

describe('unwrap pipeline', () => {
  it('runs six stages and keeps a snapshot for each', () => {
    const result = runUnwrap(makeCube(2), DEFAULT_CONFIG, {
      version: 'test',
      inputName: 'cube.obj',
    });
    expect(result.stages.map((stage) => stage.id)).toEqual([
      'condition',
      'segment',
      'parameterize',
      'normalize',
      'pack',
      'validate',
    ]);
    expect(result.stages.map((stage) => stage.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.stages[0].uvs).toBeNull();
    expect(result.stages[0].charts).toBeNull();
    expect(result.stages[1].chartOfTriangle).not.toBeNull();
    expect(result.stages[1].chartCount).toBe(6);
    expect(result.stages[2].uvs).not.toBeNull();
    expect(result.stages[2].charts).toHaveLength(6);
    expect(result.stages[4].charts).toHaveLength(6);
    expect(result.stages[5].overlapMask).not.toBeNull();
    expect(result.stages[5].atlas?.placements).toHaveLength(6);
    expect(result.stages.every((stage) => stage.durationMs >= 0)).toBe(true);
    expect(result.stages.every((stage) => stage.status === 'ok')).toBe(true);
    expect(result.report.summary.status).toBe('pass');
    expect(result.report.summary.charts).toBe(6);
    expect(result.report.stages).toHaveLength(6);
    expect(result.report.input).toBe('cube.obj');
  });

  it('reports start and done progress for every stage', () => {
    const events: string[] = [];
    runUnwrap(makeCube(2), DEFAULT_CONFIG, {
      onProgress(progress) {
        events.push(`${progress.id}:${progress.phase}`);
      },
    });
    expect(events).toHaveLength(12);
    expect(events[0]).toBe('condition:start');
    expect(events[11]).toBe('validate:done');
  });
});
