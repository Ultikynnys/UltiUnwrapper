import { describe, expect, it } from 'vitest';
import {
  STAGE_DEFAULT_VIEW,
  STAGE_VIEW_MODES,
  VIEW_LABELS,
  atlasModeFor,
  formatDuration,
  statLabel,
  weaknessViewMode,
} from '../src/ui/uiState';
import type { ChartUv, StageId, StageSnapshot } from '../src/lib/unwrap/types';

function stage(id: StageId, charts: ChartUv[] | null): StageSnapshot {
  return {
    id,
    index: 0,
    label: id,
    durationMs: 0,
    status: 'ok',
    stats: {},
    issues: [],
    uvs: null,
    chartOfTriangle: null,
    chartCount: charts?.length ?? 0,
    seamEdges: null,
    cutEdges: null,
    charts,
    atlas: null,
    face: {},
    overlapMask: null,
    overlapWidth: 0,
    overlapHeight: 0,
    weaknesses: [],
  };
}

const chart = {} as ChartUv;

describe('stage view state', () => {
  it('defines one default view per stage', () => {
    expect(STAGE_DEFAULT_VIEW.condition).toBe('clay');
    expect(STAGE_DEFAULT_VIEW.segment).toBe('charts');
    expect(STAGE_DEFAULT_VIEW.parameterize).toBe('distortion');
    expect(STAGE_DEFAULT_VIEW.normalize).toBe('density');
    expect(STAGE_DEFAULT_VIEW.pack).toBe('checker');
    expect(STAGE_DEFAULT_VIEW.validate).toBe('overlap');
    expect(STAGE_VIEW_MODES.validate).toContain('charts');
    expect(STAGE_VIEW_MODES.validate).toContain('flipped');
    expect(VIEW_LABELS.overlap).toBe('Overlap');
  });

  it('chooses the atlas mode from the stage snapshot', () => {
    expect(atlasModeFor(null)).toBe('inventory');
    expect(atlasModeFor(stage('condition', null))).toBe('inventory');
    expect(atlasModeFor(stage('segment', null))).toBe('inventory');
    expect(atlasModeFor(stage('parameterize', [chart]))).toBe('gallery');
    expect(atlasModeFor(stage('normalize', [chart]))).toBe('gallery');
    expect(atlasModeFor(stage('pack', [chart]))).toBe('atlas');
    expect(atlasModeFor(stage('validate', [chart]))).toBe('atlas');
    expect(atlasModeFor(stage('parameterize', null))).toBe('inventory');
  });

  it('maps weakness kinds to focused views', () => {
    expect(weaknessViewMode('overlap')).toBe('overlap');
    expect(weaknessViewMode('density')).toBe('density');
    expect(weaknessViewMode('flipped')).toBe('flipped');
    expect(weaknessViewMode('angle')).toBe('distortion');
    expect(weaknessViewMode('area')).toBe('area');
  });
});

describe('ui formatting', () => {
  it('turns camel-case stat keys into labels', () => {
    expect(statLabel('atlasResolution')).toBe('Atlas Resolution');
    expect(statLabel('angleP95')).toBe('Angle P95');
    expect(statLabel('non_manifold-edges')).toBe('Non Manifold Edges');
  });

  it('formats stage durations', () => {
    expect(formatDuration(0.4)).toBe('<1 ms');
    expect(formatDuration(12.4)).toBe('12 ms');
    expect(formatDuration(1234)).toBe('1.23 s');
  });
});
