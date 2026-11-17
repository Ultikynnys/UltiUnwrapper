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
    expect(stageHeadline(stage('pack', { occupancy: 0.375 }))).toBe('38% packed');
    expect(stageHeadline(stage('validate', { status: 'pass' }, 'ok'))).toBe('PASS');
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

  it('reports strategy and mirror state for islands', () => {
    const cards = stageCards(stage('islands', {
      charts: 142,
      strategyAttempts: 21,
      strategyVariants: 4,
      bestVariant: 'growth-0.50',
      bestVariantLabel: 'balanced',
      mirrorPlaneScore: 1,
      mirrorDetectedSeams: 12,
      symmetrySeams: 0,
      islandMerges: 216,
      refineStoppedEarly: 0,
    }, 'ok'));
    expect(cards.map((card) => card.label)).toEqual([
      'Islands',
      'Strategies',
      'Mirror',
      'Island merges',
    ]);
    expect(cards[1].value).toBe('21/4');
    expect(cards[1].hint).toBe('balanced');
    expect(cards[2].value).toBe('100%');
    expect(cards[2].hint).toBe('12 detected');
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
