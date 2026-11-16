import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/unwrap/config';
import { buildReport, reportSummary, serializeReport } from '../src/lib/unwrap/report';
import type { ConditionedMesh, ParameterizeResult, PackResult } from '../src/lib/unwrap/types';
import type { ValidationResult } from '../src/lib/unwrap/validate';

describe('report construction', () => {
  it('sanitizes non-finite stats and fills missing summary values', () => {
    const report = buildReport({
      version: 'test',
      input: 'mesh.obj',
      output: null,
      config: DEFAULT_CONFIG,
      mesh: {
        vertexCount: 3,
        triangleCount: 1,
        objectNames: ['Mesh'],
      } as unknown as ConditionedMesh,
      stages: [{
        id: 'condition',
        label: 'Condition',
        durationMs: 1.23456,
        stats: {
          count: 2,
          bad: Number.NaN,
          infinite: Infinity,
          label: 'ok',
          flag: true,
        },
        issues: [],
      }],
      validation: {
        status: 'pass',
        stats: {},
        topWeaknesses: [],
      } as unknown as ValidationResult,
      pack: {
        stats: {},
        scale: 0.5,
        occupancy: 0,
        placements: [],
        achievedTexelDensity: 0,
      } as unknown as PackResult,
      parameterization: { charts: [] } as unknown as ParameterizeResult,
    });

    expect(report.stages[0].durationMs).toBe(1.235);
    expect(report.stages[0].stats.bad).toBeNull();
    expect(report.stages[0].stats.infinite).toBeNull();
    expect(report.stages[0].stats.count).toBe(2);
    expect(report.stages[0].stats.label).toBe('ok');
    expect(report.stages[0].stats.flag).toBe(true);
    expect(report.summary.charts).toBe(0);
    expect(report.summary.atlas.resolution).toBe(0);
    expect(report.summary.atlas.padding).toBe(0);
    expect(report.summary.texelDensity.target).toBe(0);
    expect(report.summary.texelDensity.p50).toBe(0);
    expect(report.summary.distortion.angleP95).toBe(0);
    expect(report.summary.overlap.fraction).toBe(0);
    expect(report.summary.overlap.resolution).toBe(0);
    expect(report.output).toBeNull();
  });

  it('serializes and summarizes a report', () => {
    const report = buildReport({
      version: 'test',
      input: 'mesh.obj',
      output: 'out.obj',
      config: DEFAULT_CONFIG,
      mesh: { vertexCount: 0, triangleCount: 0, objectNames: [] } as unknown as ConditionedMesh,
      stages: [],
      validation: {
        status: 'pass',
        stats: {},
        topWeaknesses: [],
      } as unknown as ValidationResult,
      pack: {
        stats: {},
        scale: 1,
        occupancy: 0,
        placements: [],
        achievedTexelDensity: 0,
      } as unknown as PackResult,
      parameterization: { charts: [] } as unknown as ParameterizeResult,
    });
    expect(serializeReport(report).endsWith('\n')).toBe(true);
    const summary = reportSummary(report);
    expect(summary.tool).toBe('UltiUnwrapper');
    expect(summary.output).toBe('out.obj');
    expect(summary.weaknesses).toBe(0);
  });
});
