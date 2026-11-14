import { chartColorCss } from './colors';
import type { ChartPlacement, ChartUv } from './types';

export type SvgOptions = {
  atlas?: boolean;
  placements?: ChartPlacement[];
  atlasResolution?: number;
  size?: number;
  title?: string;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders charts as an SVG. Atlas mode uses [0,1] UVs and draws padding
 * rectangles; gallery mode fits every chart into one diagnostic frame. */
export function renderChartsSvg(charts: ChartUv[], options: SvgOptions = {}): string {
  const size = options.size ?? 1024;
  const atlas = options.atlas ?? false;
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const chart of charts) {
    for (let vertex = 0; vertex < chart.uvs.length / 2; vertex += 1) {
      minU = Math.min(minU, chart.uvs[vertex * 2]);
      minV = Math.min(minV, chart.uvs[vertex * 2 + 1]);
      maxU = Math.max(maxU, chart.uvs[vertex * 2]);
      maxV = Math.max(maxV, chart.uvs[vertex * 2 + 1]);
    }
  }
  if (!Number.isFinite(minU)) {
    minU = 0;
    minV = 0;
    maxU = 1;
    maxV = 1;
  }
  const width = Math.max(1e-9, maxU - minU);
  const height = Math.max(1e-9, maxV - minV);
  const margin = atlas ? 0 : size * 0.06;
  const scale = atlas ? size : Math.min((size - margin * 2) / width, (size - margin * 2) / height);
  const offsetX = atlas ? 0 : margin - minU * scale;
  const offsetY = atlas ? 0 : margin - minV * scale;
  const point = (u: number, v: number): string => {
    const x = atlas ? u * size : offsetX + u * scale;
    const y = atlas ? (1 - v) * size : size - (offsetY + v * scale);
    return `${x.toFixed(3)},${y.toFixed(3)}`;
  };

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">`);
  parts.push(`<rect width="${size}" height="${size}" fill="#171716"/>`);
  if (options.title) {
    parts.push(`<text x="24" y="36" fill="#f3f0e6" font-family="monospace" font-size="18">${escapeXml(options.title)}</text>`);
  }
  if (atlas) {
    parts.push(`<rect x="0" y="0" width="${size}" height="${size}" fill="none" stroke="#55554f" stroke-width="2"/>`);
    for (let step = 1; step < 10; step += 1) {
      const position = (step / 10) * size;
      parts.push(`<line x1="${position}" y1="0" x2="${position}" y2="${size}" stroke="#292927" stroke-width="1"/>`);
      parts.push(`<line x1="0" y1="${position}" x2="${size}" y2="${position}" stroke="#292927" stroke-width="1"/>`);
    }
  }
  for (const chart of charts) {
    for (let triangle = 0; triangle < chart.localIndices.length / 3; triangle += 1) {
      const a = chart.localIndices[triangle * 3];
      const b = chart.localIndices[triangle * 3 + 1];
      const c = chart.localIndices[triangle * 3 + 2];
      parts.push(
        `<polygon points="${point(chart.uvs[a * 2], chart.uvs[a * 2 + 1])} ${point(chart.uvs[b * 2], chart.uvs[b * 2 + 1])} ${point(chart.uvs[c * 2], chart.uvs[c * 2 + 1])}" fill="${chartColorCss(chart.chart)}" fill-opacity="0.42" stroke="${chartColorCss(chart.chart)}" stroke-width="1"/>`,
      );
    }
  }
  if (atlas && options.placements) {
    const resolution = options.atlasResolution ?? 2048;
    for (const placement of options.placements) {
      const x = (placement.x / resolution) * size;
      const y = (1 - (placement.y + placement.height) / resolution) * size;
      const w = (placement.width / resolution) * size;
      const h = (placement.height / resolution) * size;
      parts.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="none" stroke="#f3f0e6" stroke-opacity="0.5" stroke-dasharray="4 4"/>`);
    }
  }
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}
