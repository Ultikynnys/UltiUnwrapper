import { describe, expect, it } from 'vitest';
import { formatStatValue, stageCards, stageHeadline } from '../src/lib/metrics';
import type { StageId, StageSnapshot } from '../src/lib/unwrap/types';

function stage(id: StageId, stats: StageSnapshot['stats'], status: StageSnapshot['status'] = 'ok'): StageSnapshot {
  return {
    id,
    index: 0,
    label: id,
    durationMs: 1,
    status,
    stats,
    issues: [],
    uvs: null,
    chartOfTriangle: null,
    chartCount: 0,
    seamEdges: null,
    cutEdges: null,
    charts: null,
    atlas: null,
    face: {},
    overlapMask: null,
    overlapWidth: 0,
    overlapHeight: 0,
    weaknesses: [],
  };
}

describe('stage headlines', () => {
  it('summarizes each stage with its strongest number', () => {
    expect(stageHeadline(stage('condition', { triangles: 12 }))).toBe('12 tris');
    expect(stageHeadline(stage('condition', { triangles: 1 }))).toBe('1 tri');
    expect(stageHeadline(stage('segment', { charts: 6 }))).toBe('6 charts');
    expect(stageHeadline(stage('segment', { charts: 1 }))).toBe('1 chart');
    expect(stageHeadline(stage('parameterize', { angleP95: 14.5003 }))).toBe('p95 14.5 deg');
    expect(stageHeadline(stage('normalize', { densityP50: 256 }))).toBe('256 px/unit');
    expect(stageHeadline(stage('inflate', { inflatedCharts: 2 }))).toBe('2 inflated');
    expect(stageHeadline(stage('pack', { occupancy: 0.375 }))).toBe('38% packed');
    expect(stageHeadline(stage('validate', { status: 'pass' }, 'ok'))).toBe('PASS');
  });

  it('builds the inflate cards from the inflation pass', () => {
    const cards = stageCards(stage('inflate', {
      inflatedCharts: 2,
      attemptedCharts: 4,
      inflationIterations: 3,
      densityAfterSpread: 0.12,
      uvAreaFraction: 0.5,
    }));
    expect(cards.map((card) => card.label)).toEqual([
      'Inflated',
      'Steps',
      'Spread',
      'Area used',
    ]);
    expect(cards[0].value).toBe('2');
    expect(cards[0].hint).toBe('4 attempted');
    expect(cards[2].value).toBe('12.00%');
  });

  it('builds the validate cards from the final metrics', () => {
    const cards = stageCards(stage('validate', {
      overlapFraction: 0,
      angleP95: 0,
      densitySpread: 0.02,
      flipped: 0,
    }, 'ok'));
    expect(cards.map((card) => card.label)).toEqual([
      'Overlap',
      'Angle p95',
      'Density spread',
      'Flipped',
    ]);
    expect(cards[0].value).toBe('0.000%');
    expect(cards[2].value).toBe('2.00%');
  });

  it('formats numeric, boolean, and missing stat values', () => {
    expect(formatStatValue(1024)).toBe('1,024');
    expect(formatStatValue(0.123456)).toBe('0.1235');
    expect(formatStatValue(1.2)).toBe('1.2');
    expect(formatStatValue(true)).toBe('yes');
    expect(formatStatValue(null)).toBe('-');
    expect(formatStatValue(Number.NaN)).toBe('-');
  });
});
