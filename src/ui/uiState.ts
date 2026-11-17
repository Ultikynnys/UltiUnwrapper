import type { AtlasMode } from '../lib/atlas2d';
import type { StageId, StageSnapshot, WeaknessKind } from '../lib/unwrap/types';
import type { StageViewMode } from '../lib/viewport3d';

export const VIEW_LABELS: Record<StageViewMode, string> = {
  clay: 'Clay',
  charts: 'Charts',
  distortion: 'Angle distortion',
  area: 'Area distortion',
  flipped: 'Flipped faces',
  density: 'Texel density',
  checker: 'Checker',
  overlap: 'Overlap',
};

export const STAGE_VIEW_MODES: Record<StageId, StageViewMode[]> = {
  condition: ['clay'],
  project: ['clay'],
  islands: ['charts', 'clay'],
  segment: ['charts'],
  parameterize: ['distortion', 'area', 'flipped', 'charts', 'clay'],
  normalize: ['density', 'checker', 'area', 'charts'],
  pack: ['checker', 'charts', 'area'],
  validate: ['overlap', 'density', 'distortion', 'area', 'flipped', 'charts'],
};

export const STAGE_DEFAULT_VIEW: Record<StageId, StageViewMode> = {
  condition: 'clay',
  project: 'clay',
  islands: 'charts',
  segment: 'charts',
  parameterize: 'distortion',
  normalize: 'density',
  pack: 'checker',
  validate: 'overlap',
};

export function atlasModeFor(stage: StageSnapshot | null): AtlasMode {
  if (!stage || !stage.charts || stage.charts.length === 0) return 'inventory';
  if (stage.id === 'pack' || stage.id === 'validate') return 'atlas';
  if (stage.id === 'parameterize' || stage.id === 'normalize' || stage.id === 'islands') return 'gallery';
  return 'inventory';
}

export function weaknessViewMode(kind: WeaknessKind): StageViewMode {
  switch (kind) {
    case 'overlap':
      return 'overlap';
    case 'density':
      return 'density';
    case 'area':
      return 'area';
    case 'flipped':
      return 'flipped';
    default:
      return 'distortion';
  }
}

export function statLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
