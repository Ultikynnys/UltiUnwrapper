import { layoutGallery, type ChartBox, type GalleryTransform } from './atlasLayout';
import { chartColorCss } from './unwrap/colors';
import type { ChartUv, StageSnapshot } from './unwrap/types';

export type AtlasMode = 'atlas' | 'gallery' | 'inventory';

export type AtlasState = {
  stage: StageSnapshot | null;
  mode: AtlasMode;
  selectedChart: number | null;
  overlapMask: Uint8Array | null;
};

type ViewTransform = {
  plotLeft: number;
  plotTop: number;
  plotSize: number;
};

function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

export class Atlas2D {
  private readonly context: CanvasRenderingContext2D | null;
  private readonly resizeObserver: ResizeObserver;
  private readonly maskCanvas: HTMLCanvasElement;
  private state: AtlasState = {
    stage: null,
    mode: 'inventory',
    selectedChart: null,
    overlapMask: null,
  };
  private transform: ViewTransform = { plotLeft: 0, plotTop: 0, plotSize: 1 };
  private chartTransforms: GalleryTransform[] = [];
  private width = 1;
  private height = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onSelectChart: (chart: number | null) => void,
  ) {
    this.context = canvas.getContext('2d');
    this.maskCanvas = document.createElement('canvas');
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointermove', this.handleMove);
    canvas.addEventListener('click', this.handleClick);
    this.resize();
  }

  private handleMove = (event: PointerEvent): void => {
    const chart = this.chartAt(event);
    this.canvas.style.cursor = chart === null ? 'default' : 'pointer';
    this.canvas.title = chart === null ? '' : `Chart ${chart}`;
  };

  private handleClick = (event: MouseEvent): void => {
    this.onSelectChart(this.chartAt(event));
  };

  private hitChart(chart: ChartUv, u: number, v: number): boolean {
    for (let triangle = 0; triangle < chart.localIndices.length / 3; triangle += 1) {
      const a = chart.localIndices[triangle * 3];
      const b = chart.localIndices[triangle * 3 + 1];
      const c = chart.localIndices[triangle * 3 + 2];
      if (pointInTriangle(
        u, v,
        chart.uvs[a * 2], chart.uvs[a * 2 + 1],
        chart.uvs[b * 2], chart.uvs[b * 2 + 1],
        chart.uvs[c * 2], chart.uvs[c * 2 + 1],
      )) {
        return true;
      }
    }
    return false;
  }

  private chartAt(event: MouseEvent): number | null {
    const charts = this.state.stage?.charts;
    if (!charts || this.chartTransforms.length !== charts.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    for (let index = 0; index < charts.length; index += 1) {
      const transform = this.chartTransforms[index];
      const chart = charts[index];
      if (!transform || !chart) continue;
      const u = transform.minU + (x - transform.left) / transform.scale;
      const v = transform.maxV - (y - transform.top) / transform.scale;
      if (this.hitChart(chart, u, v)) return chart.chart;
    }
    return null;
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, this.canvas.clientWidth);
    this.height = Math.max(1, this.canvas.clientHeight);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.context?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  setState(state: AtlasState): void {
    this.state = state;
    this.draw();
  }

  private background(context: CanvasRenderingContext2D): void {
    context.clearRect(0, 0, this.width, this.height);
    context.fillStyle = '#0d0d0c';
    context.fillRect(0, 0, this.width, this.height);
  }

  private drawMessage(message: string, subline = ''): void {
    const context = this.context;
    if (!context) return;
    this.background(context);
    context.fillStyle = '#d7d3c8';
    context.font = '600 12px "Manrope", sans-serif';
    context.textAlign = 'center';
    context.fillText(message, this.width / 2, this.height / 2 - 4);
    if (subline) {
      context.fillStyle = '#77776e';
      context.font = '10px "DM Mono", monospace';
      context.fillText(subline, this.width / 2, this.height / 2 + 16);
    }
  }

  private drawInventory(): void {
    const context = this.context;
    const stage = this.state.stage;
    if (!context || !stage) return;
    this.background(context);
    context.fillStyle = '#d7d3c8';
    context.font = '600 13px "Manrope", sans-serif';
    context.textAlign = 'left';
    context.fillText(`${stage.chartCount} charts`, 18, 30);
    context.fillStyle = '#97978e';
    context.font = '10px "DM Mono", monospace';
    context.fillText('Charts are not flattened yet.', 18, 52);
    context.fillText('Select Parameterize to inspect the layouts.', 18, 68);
  }

  private chartBounds(chart: ChartUv): ChartBox {
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (let vertex = 0; vertex < chart.uvs.length / 2; vertex += 1) {
      minU = Math.min(minU, chart.uvs[vertex * 2]);
      minV = Math.min(minV, chart.uvs[vertex * 2 + 1]);
      maxU = Math.max(maxU, chart.uvs[vertex * 2]);
      maxV = Math.max(maxV, chart.uvs[vertex * 2 + 1]);
    }
    if (!Number.isFinite(minU)) return { minU: 0, minV: 0, maxU: 1, maxV: 1 };
    return { minU, minV, maxU, maxV };
  }

  private drawOverlap(context: CanvasRenderingContext2D): void {
    const mask = this.state.overlapMask;
    if (!mask) return;
    const resolution = Math.round(Math.sqrt(mask.length));
    if (resolution <= 0) return;
    if (this.maskCanvas.width !== resolution) {
      this.maskCanvas.width = resolution;
      this.maskCanvas.height = resolution;
    }
    const maskContext = this.maskCanvas.getContext('2d');
    if (!maskContext) return;
    const image = maskContext.createImageData(resolution, resolution);
    for (let index = 0; index < mask.length; index += 1) {
      if (mask[index] < 2) continue;
      image.data[index * 4] = 255;
      image.data[index * 4 + 1] = 52;
      image.data[index * 4 + 2] = 52;
      image.data[index * 4 + 3] = 220;
    }
    maskContext.putImageData(image, 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(
      this.maskCanvas,
      this.transform.plotLeft,
      this.transform.plotTop,
      this.transform.plotSize,
      this.transform.plotSize,
    );
    context.imageSmoothingEnabled = true;
  }

  private drawChart(
    context: CanvasRenderingContext2D,
    chart: ChartUv,
    transform: GalleryTransform,
  ): void {
    const selected = this.state.selectedChart === chart.chart;
    const dim = this.state.selectedChart !== null && !selected;
    const toX = (u: number): number => transform.left + (u - transform.minU) * transform.scale;
    const toY = (v: number): number => transform.top + (transform.maxV - v) * transform.scale;
    context.globalAlpha = dim ? 0.22 : selected ? 1 : 0.72;
    context.beginPath();
    for (let triangle = 0; triangle < chart.localIndices.length / 3; triangle += 1) {
      const a = chart.localIndices[triangle * 3];
      const b = chart.localIndices[triangle * 3 + 1];
      const c = chart.localIndices[triangle * 3 + 2];
      context.moveTo(toX(chart.uvs[a * 2]), toY(chart.uvs[a * 2 + 1]));
      context.lineTo(toX(chart.uvs[b * 2]), toY(chart.uvs[b * 2 + 1]));
      context.lineTo(toX(chart.uvs[c * 2]), toY(chart.uvs[c * 2 + 1]));
      context.closePath();
    }
    context.fillStyle = chartColorCss(chart.chart);
    context.fill();
    context.lineWidth = selected ? 1.8 : 0.7;
    context.strokeStyle = selected ? '#f3f0e6' : 'rgba(243, 240, 230, 0.42)';
    context.stroke();

    context.globalAlpha = 1;
  }

  private drawAtlas(context: CanvasRenderingContext2D, charts: ChartUv[]): void {
    const size = Math.min(this.width, this.height);
    const plotLeft = (this.width - size) / 2;
    const plotTop = (this.height - size) / 2;
    this.transform = { plotLeft, plotTop, plotSize: size };
    this.chartTransforms = charts.map(() => ({
      left: plotLeft,
      top: plotTop,
      scale: size,
      minU: 0,
      maxV: 1,
    }));

    context.strokeStyle = '#41413d';
    context.lineWidth = 1;
    context.strokeRect(plotLeft, plotTop, size, size);
    context.strokeStyle = '#222220';
    for (let step = 1; step < 10; step += 1) {
      const x = plotLeft + (step / 10) * size;
      const y = plotTop + (step / 10) * size;
      context.beginPath();
      context.moveTo(x, plotTop);
      context.lineTo(x, plotTop + size);
      context.moveTo(plotLeft, y);
      context.lineTo(plotLeft + size, y);
      context.stroke();
    }

    for (let index = 0; index < charts.length; index += 1) {
      const chart = charts[index];
      const transform = this.chartTransforms[index];
      if (chart && transform) this.drawChart(context, chart, transform);
    }

    this.drawOverlap(context);
    const padding = this.state.stage?.atlas?.padding ?? 0;
    const resolution = this.state.stage?.atlas?.resolution ?? 1;
    const placements = this.state.stage?.atlas?.placements ?? [];
    const boundsOverlap = placements.some((a, i) => placements.slice(i + 1).some((b) => (
      a.x < b.x + b.width && a.x + a.width > b.x
      && a.y < b.y + b.height && a.y + a.height > b.y
    )));
    if (padding > 0 && resolution > 0 && !boundsOverlap) {
      context.strokeStyle = 'rgba(243, 240, 230, 0.35)';
      context.setLineDash([3, 3]);
      context.lineWidth = 1;
      for (const placement of this.state.stage?.atlas?.placements ?? []) {
        const x = plotLeft + ((placement.x - padding) / resolution) * size;
        const y = plotTop + (1 - (placement.y + placement.height + padding) / resolution) * size;
        const width = ((placement.width + padding * 2) / resolution) * size;
        const height = ((placement.height + padding * 2) / resolution) * size;
        context.strokeRect(x, y, width, height);
      }
      context.setLineDash([]);
    }
  }

  private drawGallery(context: CanvasRenderingContext2D, charts: ChartUv[]): void {
    const layout = layoutGallery(
      charts.map((chart) => this.chartBounds(chart)),
      this.width,
      this.height,
    );
    this.chartTransforms = layout.transforms;

    context.strokeStyle = '#222220';
    context.lineWidth = 1;
    for (let row = 0; row < layout.rows; row += 1) {
      for (let column = 0; column < layout.columns; column += 1) {
        context.strokeRect(
          layout.side + column * layout.cellWidth + 1,
          layout.top + row * layout.cellHeight + 1,
          layout.cellWidth - 2,
          layout.cellHeight - 2,
        );
      }
    }

    for (let index = 0; index < charts.length; index += 1) {
      const chart = charts[index];
      const transform = this.chartTransforms[index];
      if (chart && transform) this.drawChart(context, chart, transform);
    }
  }

  private draw(): void {
    const context = this.context;
    const stage = this.state.stage;
    if (!context) return;
    if (!stage) {
      this.chartTransforms = [];
      this.drawMessage('Import a model', 'or load the demo cube to start');
      return;
    }
    if (!stage.charts || stage.charts.length === 0) {
      this.chartTransforms = [];
      this.drawInventory();
      return;
    }

    const charts = stage.charts;
    const atlas = this.state.mode === 'atlas';
    this.background(context);
    if (atlas) {
      this.drawAtlas(context, charts);
    } else {
      this.drawGallery(context, charts);
    }

    context.fillStyle = '#97978e';
    context.font = '9px "DM Mono", monospace';
    context.textAlign = 'left';
    context.fillText(atlas ? 'ATLAS' : 'CHART GALLERY', 14, 18);
    if (this.state.selectedChart !== null) {
      context.fillStyle = '#f3f0e6';
      context.fillText(`CHART ${this.state.selectedChart}`, 14, this.height - 8);
    }
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointermove', this.handleMove);
    this.canvas.removeEventListener('click', this.handleClick);
  }
}
