import type { StageSnapshot } from './unwrap/types';

export type MetricCard = {
  label: string;
  value: string;
  hint?: string;
};

function count(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value).toLocaleString('en-US')
    : String(value ?? '-');
}

function fixed(value: unknown, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function percent(value: unknown, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '-';
}

export function stageHeadline(stage: StageSnapshot): string {
  switch (stage.id) {
    case 'condition': {
      const triangles = Number(stage.stats.triangles ?? 0);
      return `${count(triangles)} ${triangles === 1 ? 'tri' : 'tris'}`;
    }
    case 'segment': {
      const charts = Number(stage.stats.charts ?? 0);
      return `${count(charts)} ${charts === 1 ? 'chart' : 'charts'}`;
    }
    case 'parameterize':
      return `p95 ${fixed(stage.stats.angleP95, 1)} deg`;
    case 'normalize':
      return `${fixed(stage.stats.densityP50, 0)} px/unit`;
    case 'relax':
      return `${count(stage.stats.relaxedFaces)} faces`;
    case 'pack':
      return `${percent(stage.stats.occupancy, 0)} packed`;
    case 'validate':
      return String(stage.stats.status ?? stage.status).toUpperCase();
    default:
      return '';
  }
}

export function stageCards(stage: StageSnapshot): MetricCard[] {
  switch (stage.id) {
    case 'condition':
      return [
        { label: 'Triangles', value: count(stage.stats.triangles) },
        { label: 'Welded verts', value: count(stage.stats.weldedVertices) },
        { label: 'Degenerate', value: count(stage.stats.degenerateRemoved), hint: 'removed' },
        { label: 'Non-manifold', value: count(stage.stats.nonManifoldEdges), hint: 'edges' },
      ];
    case 'segment':
      return [
        { label: 'Charts', value: count(stage.stats.charts) },
        { label: 'Seam edges', value: count(stage.stats.seamEdges) },
        { label: 'Seam length', value: fixed(stage.stats.seamLength, 2) },
        { label: 'Cuts', value: count(stage.stats.cutsAdded), hint: `${count(stage.stats.closedChartsBeforeCuts)} closed first` },
      ];
    case 'parameterize':
      return [
        { label: 'Angle p50', value: `${fixed(stage.stats.angleP50, 2)} deg` },
        { label: 'Angle p95', value: `${fixed(stage.stats.angleP95, 2)} deg` },
        { label: 'Area p95', value: fixed(stage.stats.areaP95, 2), hint: 'octaves' },
        { label: 'Flipped', value: count(stage.stats.flipped), hint: `${count(stage.stats.failedCharts)} failed` },
      ];
    case 'normalize':
      return [
        { label: 'Target', value: `${fixed(stage.stats.targetDensity, 0)} px/unit` },
        { label: 'Density p50', value: `${fixed(stage.stats.densityP50, 1)} px/unit` },
        { label: 'Spread', value: percent(stage.stats.densityAfterSpread, 2) },
        { label: 'Area needed', value: percent(stage.stats.requiredAreaFraction, 1), hint: 'before packing' },
      ];
    case 'relax':
      return [
        { label: 'Before spread', value: percent(stage.stats.densityBeforeSpread, 2) },
        { label: 'After spread', value: percent(stage.stats.densityAfterSpread, 2) },
        { label: 'Relaxed faces', value: count(stage.stats.relaxedFaces), hint: `${count(stage.stats.relaxedVertices)} verts` },
        { label: 'Boid passes', value: count(stage.stats.boidPasses), hint: 'stops when difference rises' },
        { label: 'Density diff', value: `${fixed(stage.stats.densityDifferenceBefore, 4)} -> ${fixed(stage.stats.densityDifferenceAfter, 4)}`, hint: 'mean distance from average' },
      ];
    case 'pack':
      return [
        { label: 'Occupancy', value: percent(stage.stats.occupancy, 1) },
        { label: 'Density', value: `${fixed(stage.stats.achievedDensity, 1)} px/unit` },
        { label: 'Fit scale', value: fixed(stage.stats.scale, 3) },
        { label: 'Placements', value: count(stage.stats.charts), hint: `${count(stage.stats.rotatedCharts)} rotated` },
      ];
    case 'validate':
      return [
        { label: 'Overlap', value: percent(stage.stats.overlapFraction, 3) },
        { label: 'Angle p95', value: `${fixed(stage.stats.angleP95, 2)} deg` },
        { label: 'Density spread', value: percent(stage.stats.densitySpread, 2) },
        { label: 'Flipped', value: count(stage.stats.flipped) },
      ];
    default:
      return [];
  }
}

export function formatStatValue(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '-';
    if (Number.isInteger(value)) return value.toLocaleString('en-US');
    return value.toFixed(4).replace(/\.?0+$/, '');
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value ?? '-');
}

export function renderHistogram(
  canvas: HTMLCanvasElement,
  values: ArrayLike<number> | null,
  options: { max: number; color: string; label: string; p95?: boolean },
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#222220';
  context.fillRect(0, 0, width, height);

  if (!values || values.length === 0) {
    context.fillStyle = '#77776e';
    context.font = '9px "DM Mono", monospace';
    context.fillText('no data', 8, height / 2);
    return;
  }

  const bins = 24;
  const histogram = new Float64Array(bins);
  let max = 0;
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (!Number.isFinite(raw)) continue;
    const value = Math.max(0, raw);
    const bin = Math.min(bins - 1, Math.floor((value / options.max) * bins));
    histogram[bin] += 1;
    if (histogram[bin] > max) max = histogram[bin];
  }
  const plotLeft = 6;
  const plotTop = 16;
  const plotWidth = width - 12;
  const plotHeight = height - 24;
  context.fillStyle = options.color;
  for (let bin = 0; bin < bins; bin += 1) {
    const barWidth = plotWidth / bins;
    const barHeight = max > 0 ? (histogram[bin] / max) * plotHeight : 0;
    context.fillRect(
      plotLeft + bin * barWidth,
      plotTop + plotHeight - barHeight,
      Math.max(1, barWidth - 1),
      barHeight,
    );
  }
  context.fillStyle = '#97978e';
  context.font = '8px "DM Mono", monospace';
  context.fillText(options.label, plotLeft, 10);
  context.fillText(options.max.toFixed(0), width - 22, 10);
  if (options.p95) {
    const sorted = Float64Array.from(values);
    sorted.sort();
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
    const x = plotLeft + Math.min(1, p95 / options.max) * plotWidth;
    context.strokeStyle = '#f3f0e6';
    context.setLineDash([2, 2]);
    context.beginPath();
    context.moveTo(x, plotTop);
    context.lineTo(x, plotTop + plotHeight);
    context.stroke();
    context.setLineDash([]);
  }
}
