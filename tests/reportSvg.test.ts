import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/unwrap/config';
import { runUnwrap } from '../src/lib/unwrap/pipeline';
import { reportSummary, serializeReport } from '../src/lib/unwrap/report';
import { renderChartsSvg } from '../src/lib/unwrap/svg';
import { makeCube } from './helpers/meshes';

describe('report and stage SVG', () => {
  const result = runUnwrap(makeCube(2), DEFAULT_CONFIG, { version: 'test', inputName: 'cube.obj' });

  it('serializes a finite report', () => {
    const text = serializeReport(result.report);
    expect(text).not.toContain('Infinity');
    expect(text).not.toContain('NaN');
    const parsed = JSON.parse(text);
    expect(parsed.tool).toBe('UltiUnwrapper');
    expect(parsed.schema).toBe(1);
    expect(parsed.stages).toHaveLength(6);
    expect(parsed.summary.status).toBe('pass');
    expect(parsed.summary.atlas.placements).toBe(6);
    expect(parsed.summary.overlap.fraction).toBe(0);
  });

  it('summarizes the report for --json', () => {
    const summary = reportSummary(result.report);
    expect(summary.status).toBe('pass');
    expect(summary.charts).toBe(6);
    expect(summary.weaknesses).toBe(0);
  });

  it('renders atlas and gallery SVGs', () => {
    const charts = result.pack.charts;
    const atlas = renderChartsSvg(charts, {
      atlas: true,
      placements: result.pack.placements,
      atlasResolution: 2048,
      title: '<atlas>',
    });
    expect(atlas).toContain('<svg');
    expect(atlas).toContain('<polygon');
    expect(atlas).toContain('stroke-dasharray');
    expect(atlas).toContain('&lt;atlas&gt;');
    const gallery = renderChartsSvg(charts, { title: 'gallery' });
    expect(gallery).toContain('<svg');
    expect(gallery).toContain('gallery');
    const empty = renderChartsSvg([], { atlas: true });
    expect(empty).toContain('<svg');
  });
});
