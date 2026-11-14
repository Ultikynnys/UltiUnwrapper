import { BUILD_VERSION } from '../lib/buildInfo';
import { Atlas2D } from '../lib/atlas2d';
import { createDemoCube } from '../lib/demoMesh';
import { exportGlb } from '../lib/unwrap/exportGlb';
import { buildExportMesh } from '../lib/unwrap/exportMesh';
import { exportObj } from '../lib/unwrap/exportObj';
import { serializeReport } from '../lib/unwrap/report';
import {
  DEFAULT_CONFIG,
  STAGE_LABELS,
  STAGE_ORDER,
  mergeConfig,
  type UnwrapConfig,
} from '../lib/unwrap/config';
import { runUnwrap, type RunProgress, type UnwrapResult } from '../lib/unwrap/pipeline';
import type { RawMesh, StageId, StageSnapshot, WeaknessKind } from '../lib/unwrap/types';
import { flattenScene } from '../lib/threeGeometry';
import { createModelFileBundle, type ModelFileBundle } from '../lib/modelFiles';
import { loadModelFromBundle } from '../lib/modelLoad';
import { formatStatValue, renderHistogram, stageCards, stageHeadline } from '../lib/metrics';
import { Viewport3D, type StageViewMode } from '../lib/viewport3d';
import {
  STAGE_DEFAULT_VIEW,
  STAGE_VIEW_MODES,
  VIEW_LABELS,
  atlasModeFor,
  formatDuration,
  statLabel,
  weaknessViewMode,
} from './uiState';

type WorkerMessage =
  | { type: 'progress'; progress: RunProgress }
  | { type: 'result'; result: UnwrapResult }
  | { type: 'error'; message: string };

const STAGE_DESCRIPTIONS: Record<StageId, string> = {
  condition: 'Weld vertices, drop degenerates, and measure the input.',
  segment: 'Find seams and split the mesh into charts.',
  parameterize: 'Solve per-chart UVs and measure angle and area distortion.',
  normalize: 'Scale every chart toward the target texel density.',
  inflate: 'Inflate low-density faces with a smooth falloff; dense faces stay fixed.',
  pack: 'Place charts into the atlas and report occupancy.',
  validate: 'Rasterize overlap and rank the weakest charts.',
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`Missing UI element #${id}.`);
  return element;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SummaryFinding = {
  severity: 'warn' | 'error';
  message: string;
};

function summaryFindings(result: UnwrapResult): SummaryFinding[] {
  const findings: SummaryFinding[] = [];
  for (const issue of result.validation.issues) {
    if (issue.severity === 'error' || issue.severity === 'warn') {
      findings.push({ severity: issue.severity, message: issue.message });
    }
  }
  if (findings.length === 0) {
    for (const stage of result.stages) {
      for (const issue of stage.issues) {
        if (issue.severity === 'error' || issue.severity === 'warn') {
          findings.push({ severity: issue.severity, message: issue.message });
        }
      }
    }
  }
  if (!findings.some((finding) => finding.severity === 'error')) {
    for (const weakness of result.validation.topWeaknesses) {
      if (weakness.severity === 'error') {
        findings.push({ severity: 'error', message: weakness.message });
      }
    }
  }
  return findings.sort((a, b) => (
    a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1
  ));
}

function weaknessValue(kind: WeaknessKind, value: number): string {
  if (!Number.isFinite(value)) return '-';
  switch (kind) {
    case 'overlap':
      return `${(value * 100).toFixed(2)}%`;
    case 'angle':
      return `${value.toFixed(1)} deg`;
    case 'area':
      return `${value.toFixed(2)}x`;
    case 'density':
      return `${(value * 100).toFixed(0)}%`;
    case 'flipped':
      return `${Math.round(value)}`;
    default:
      return value.toFixed(2);
  }
}

export class App {
  private readonly runStatus = byId<HTMLSpanElement>('runStatus');
  private readonly stepList = byId<HTMLOListElement>('stepList');
  private readonly stageProgress = byId<HTMLSpanElement>('stageProgress');
  private readonly runSummary = byId<HTMLDivElement>('runSummary');
  private readonly stageTitle = byId<HTMLHeadingElement>('stageTitle');
  private readonly stageSubtitle = byId<HTMLParagraphElement>('stageSubtitle');
  private readonly stageColumn = byId<HTMLElement>('stageColumn');
  private readonly viewMode = byId<HTMLSelectElement>('viewMode');
  private readonly toggleSeams = byId<HTMLInputElement>('toggleSeams');
  private readonly toggleWireframe = byId<HTMLInputElement>('toggleWireframe');
  private readonly clearChart = byId<HTMLButtonElement>('clearChart');
  private readonly viewportHud = byId<HTMLDivElement>('viewportHud');
  private readonly atlasHint = byId<HTMLDivElement>('atlasHint');
  private readonly busyOverlay = byId<HTMLDivElement>('busyOverlay');
  private readonly busyText = byId<HTMLSpanElement>('busyText');
  private readonly metricStrip = byId<HTMLDivElement>('metricStrip');
  private readonly detailsMeta = byId<HTMLSpanElement>('detailsMeta');
  private readonly stageDetails = byId<HTMLDivElement>('stageDetails');
  private readonly histogramMeta = byId<HTMLSpanElement>('histogramMeta');
  private readonly histogram = byId<HTMLCanvasElement>('histogram');
  private readonly weaknessMeta = byId<HTMLSpanElement>('weaknessMeta');
  private readonly weaknessList = byId<HTMLDivElement>('weaknessList');
  private readonly importModel = byId<HTMLButtonElement>('importModel');
  private readonly loadDemo = byId<HTMLButtonElement>('loadDemo');
  private readonly runButton = byId<HTMLButtonElement>('runUnwrap');
  private readonly exportObjButton = byId<HTMLButtonElement>('exportObj');
  private readonly exportGlbButton = byId<HTMLButtonElement>('exportGlb');
  private readonly exportReportButton = byId<HTMLButtonElement>('exportReport');
  private readonly modelFileInput = byId<HTMLInputElement>('modelFileInput');
  private readonly dropOverlay = byId<HTMLDivElement>('dropOverlay');
  private readonly toast = byId<HTMLDivElement>('toast');
  private readonly settingAtlas = byId<HTMLSelectElement>('settingAtlas');
  private readonly settingPadding = byId<HTMLInputElement>('settingPadding');
  private readonly settingSeamAngle = byId<HTMLInputElement>('settingSeamAngle');
  private readonly settingDensity = byId<HTMLInputElement>('settingDensity');
  private readonly settingRotation = byId<HTMLInputElement>('settingRotation');
  private readonly settingFitAtlas = byId<HTMLInputElement>('settingFitAtlas');
  private readonly settingSplitObject = byId<HTMLInputElement>('settingSplitObject');
  private readonly resetSettings = byId<HTMLButtonElement>('resetSettings');
  private readonly viewport: Viewport3D;
  private readonly atlas: Atlas2D;

  private raw: RawMesh | null = null;
  private bundle: ModelFileBundle | null = null;
  private result: UnwrapResult | null = null;
  private selectedStage = 0;
  private selectedChart: number | null = null;
  private viewModeValue: StageViewMode = 'clay';
  private showSeams = true;
  private showWireframe = false;
  private busy = false;
  private progress: RunProgress | null = null;
  private worker: Worker | null = null;
  private toastTimer = 0;
  private histogramFrame = 0;
  private modelName = '';
  private settingsDirty = false;
  private runFailure: string | null = null;
  private importToken = 0;
  private config: UnwrapConfig = {
    ...DEFAULT_CONFIG,
    thresholds: { ...DEFAULT_CONFIG.thresholds },
  };

  constructor() {
    this.viewport = new Viewport3D(byId<HTMLCanvasElement>('viewportCanvas'), (chart) => {
      this.selectChart(chart);
    });
    this.atlas = new Atlas2D(byId<HTMLCanvasElement>('atlasCanvas'), (chart) => {
      this.selectChart(chart);
    });
    this.toggleSeams.checked = this.showSeams;
    this.bindEvents();
    this.syncSettings();
    this.render();
  }

  private bindEvents(): void {
    this.importModel.addEventListener('click', () => this.modelFileInput.click());
    this.loadDemo.addEventListener('click', () => this.loadDemoMesh());
    this.modelFileInput.addEventListener('change', () => {
      const files = this.modelFileInput.files;
      if (files) void this.importFiles(files);
      this.modelFileInput.value = '';
    });
    this.runButton.addEventListener('click', () => this.run());
    this.exportObjButton.addEventListener('click', () => this.exportAsObj());
    this.exportGlbButton.addEventListener('click', () => this.exportAsGlb());
    this.exportReportButton.addEventListener('click', () => this.exportReportJson());
    this.stepList.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-step]');
      if (!item || !this.result) return;
      this.selectStage(Number(item.dataset.step));
    });
    this.viewMode.addEventListener('change', () => {
      this.viewModeValue = this.viewMode.value as StageViewMode;
      this.render();
    });
    this.toggleSeams.addEventListener('change', () => {
      this.showSeams = this.toggleSeams.checked;
      this.render();
    });
    this.toggleWireframe.addEventListener('change', () => {
      this.showWireframe = this.toggleWireframe.checked;
      this.render();
    });
    this.clearChart.addEventListener('click', () => {
      this.selectedChart = null;
      this.render();
    });
    this.weaknessList.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-chart]');
      if (!item) return;
      this.focusWeakness(
        Number(item.dataset.chart),
        (item.dataset.kind ?? 'angle') as WeaknessKind,
      );
    });
    this.settingAtlas.addEventListener('change', () => this.onSettingsChanged());
    this.settingPadding.addEventListener('input', () => this.onSettingsChanged());
    this.settingSeamAngle.addEventListener('input', () => this.onSettingsChanged());
    this.settingDensity.addEventListener('input', () => this.onSettingsChanged());
    this.settingRotation.addEventListener('change', () => this.onSettingsChanged());
    this.settingFitAtlas.addEventListener('change', () => this.onSettingsChanged());
    this.settingSplitObject.addEventListener('change', () => this.onSettingsChanged());
    this.resetSettings.addEventListener('click', () => {
      this.config = { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds } };
      this.settingsDirty = false;
      this.syncSettings();
      this.renderSummary();
      this.showToast('Run settings reset to defaults.');
    });

    let dragDepth = 0;
    window.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      dragDepth += 1;
      this.dropOverlay.hidden = false;
    });
    window.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
    });
    window.addEventListener('dragleave', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) this.dropOverlay.hidden = true;
    });
    window.addEventListener('drop', (event) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      dragDepth = 0;
      this.dropOverlay.hidden = true;
      void this.importFiles(event.dataTransfer.files);
    });
    window.addEventListener('resize', () => this.scheduleHistogram());
    window.addEventListener('beforeunload', () => {
      this.stopWorker();
      this.bundle?.revoke();
      this.viewport.dispose();
      this.atlas.dispose();
    });
  }

  private async importFiles(files: FileList | File[]): Promise<void> {
    const token = ++this.importToken;
    if (this.busy) this.stopWorker();
    this.busy = true;
    this.progress = null;
    this.render();
    let bundle: ModelFileBundle | null = null;
    try {
      bundle = createModelFileBundle(files);
      const scene = await loadModelFromBundle(bundle);
      if (token !== this.importToken) {
        bundle.revoke();
        return;
      }
      const flattened = flattenScene(scene);
      if (flattened.mesh.indices.length === 0) {
        throw new Error('The model has no visible triangles.');
      }
      this.replaceBundle(bundle);
      bundle = null;
      this.raw = flattened.mesh;
      this.modelName = this.bundle?.primary.name ?? 'mesh';
      this.result = null;
      this.selectedStage = 0;
      this.selectedChart = null;
      this.settingsDirty = false;
      this.runFailure = null;
      this.busy = false;
      this.render();
      if (flattened.skipped.length > 0) {
        this.showToast(`${flattened.skipped.length} mesh${flattened.skipped.length === 1 ? '' : 'es'} skipped.`, 'warn');
      }
      this.run();
    } catch (error) {
      bundle?.revoke();
      if (token !== this.importToken) return;
      this.busy = false;
      this.render();
      this.showToast(`Could not load model: ${errorMessage(error)}`, 'error');
    }
  }

  private loadDemoMesh(): void {
    this.importToken += 1;
    if (this.busy) this.stopWorker();
    this.replaceBundle(null);
    this.raw = createDemoCube();
    this.modelName = 'Demo cube';
    this.result = null;
    this.selectedStage = 0;
    this.selectedChart = null;
    this.settingsDirty = false;
    this.runFailure = null;
    this.busy = false;
    this.progress = null;
    this.render();
    this.run();
  }

  private replaceBundle(bundle: ModelFileBundle | null): void {
    this.bundle?.revoke();
    this.bundle = bundle;
  }

  private run(): void {
    if (!this.raw || this.busy) return;
    this.stopWorker();
    this.busy = true;
    this.progress = { id: 'condition', index: 0, total: STAGE_ORDER.length, phase: 'start' };
    this.settingsDirty = false;
    this.runFailure = null;
    this.render();
    try {
      const worker = new Worker(new URL('../lib/unwrap/unwrap.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        if (this.worker !== worker) return;
        this.handleWorkerMessage(event.data);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.worker !== worker) return;
        this.finishError(new Error(event.message || 'The unwrap worker failed.'));
      };
      worker.onmessageerror = () => {
        if (this.worker !== worker) return;
        this.finishError(new Error('The unwrap worker returned an unreadable result.'));
      };
      worker.postMessage({
        type: 'run',
        raw: this.raw,
        config: this.config,
        version: BUILD_VERSION,
        inputName: this.modelName,
      });
    } catch (error) {
      this.runSynchronously(error);
    }
  }

  private handleWorkerMessage(message: WorkerMessage): void {
    if (message.type === 'progress') {
      this.progress = message.progress;
      this.render();
      return;
    }
    if (message.type === 'result') {
      this.finishRun(message.result);
      return;
    }
    this.finishError(new Error(message.message));
  }

  private runSynchronously(reason: unknown): void {
    if (!this.raw) return;
    console.warn('Falling back to the main thread:', errorMessage(reason));
    this.showToast('Worker unavailable, running on the main thread.', 'warn');
    try {
      const result = runUnwrap(this.raw, this.config, {
        version: BUILD_VERSION,
        inputName: this.modelName,
        onProgress: (progress) => {
          this.progress = progress;
          this.render();
        },
      });
      this.finishRun(result);
    } catch (error) {
      this.finishError(error);
    }
  }

  private finishRun(result: UnwrapResult): void {
    this.stopWorker();
    this.result = result;
    this.runFailure = null;
    this.busy = false;
    this.progress = null;
    this.selectedStage = STAGE_ORDER.length - 1;
    this.selectedChart = null;
    this.viewModeValue = 'overlap';
    this.render();
    const status = result.validation.status;
    const kind = status === 'pass' ? 'info' : status === 'warn' ? 'warn' : 'error';
    const charts = Number(result.validation.stats.charts ?? result.pack.charts.length);
    const findings = summaryFindings(result);
    const finding = findings.find((item) => item.severity === (status === 'error' ? 'error' : 'warn'))
      ?? findings[0];
    const reason = finding ? ` ${finding.message}` : '';
    this.showToast(`Unwrap ${status}. ${charts} ${charts === 1 ? 'chart' : 'charts'} ready.${reason}`, kind);
  }

  private finishError(error: unknown): void {
    this.stopWorker();
    this.runFailure = errorMessage(error);
    this.busy = false;
    this.progress = null;
    this.render();
    this.showToast(`Unwrap failed: ${errorMessage(error)}`, 'error');
  }

  private stopWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  private selectStage(index: number): void {
    if (!this.result) return;
    this.selectedStage = clamp(Math.round(index), 0, this.result.stages.length - 1);
    const stage = this.result.stages[this.selectedStage];
    this.viewModeValue = STAGE_DEFAULT_VIEW[stage.id];
    this.selectedChart = null;
    this.render();
  }

  private selectChart(chart: number | null): void {
    this.selectedChart = chart;
    this.render();
  }

  private focusWeakness(chart: number, kind: WeaknessKind): void {
    this.selectedStage = STAGE_ORDER.length - 1;
    this.selectedChart = chart;
    this.viewModeValue = weaknessViewMode(kind);
    this.render();
  }

  private onSettingsChanged(): void {
    const base = this.config;
    const number = (input: HTMLInputElement, fallback: number, min: number, max: number): number => {
      const value = Number(input.value);
      return Number.isFinite(value) ? clamp(value, min, max) : fallback;
    };
    this.config = mergeConfig(base, {
      atlasResolution: Number(this.settingAtlas.value),
      padding: Math.round(number(this.settingPadding, base.padding, 0, 256)),
      seamAngle: number(this.settingSeamAngle, base.seamAngle, 0, 180),
      targetTexelDensity: number(this.settingDensity, base.targetTexelDensity, 1, 16384),
      allowRotation: this.settingRotation.checked,
      fitToAtlas: this.settingFitAtlas.checked,
      splitByObject: this.settingSplitObject.checked,
    });
    this.settingsDirty = true;
    this.renderSummary();
  }

  private syncSettings(): void {
    this.settingAtlas.value = String(this.config.atlasResolution);
    this.settingPadding.value = String(this.config.padding);
    this.settingSeamAngle.value = String(this.config.seamAngle);
    this.settingDensity.value = String(this.config.targetTexelDensity);
    this.settingRotation.checked = this.config.allowRotation;
    this.settingFitAtlas.checked = this.config.fitToAtlas;
    this.settingSplitObject.checked = this.config.splitByObject;
  }

  private get currentStage(): StageSnapshot | null {
    if (!this.result) return null;
    return this.result.stages[this.selectedStage] ?? null;
  }

  private render(): void {
    this.renderStatus();
    this.renderSteps();
    this.renderStageHeader();
    this.renderControls();
    this.renderViewport();
    this.renderAtlas();
    this.renderMetrics();
    this.renderDetails();
    this.renderWeaknesses();
    this.renderSummary();
    this.renderBusy();
    this.renderExportButtons();
    this.scheduleHistogram();
  }

  private renderStatus(): void {
    let label = 'IDLE';
    let state = 'is-idle';
    if (this.busy) {
      label = 'RUNNING';
      state = 'is-running';
    } else if (this.runFailure) {
      label = 'ERROR';
      state = 'is-error';
    } else if (this.result) {
      label = this.result.validation.status.toUpperCase();
      state = `is-${this.result.validation.status}`;
    }
    this.runStatus.textContent = label;
    this.runStatus.className = `run-status ${state}`;
  }

  private renderSteps(): void {
    const progress = this.progress;
    const items = STAGE_ORDER.map((id, index) => {
      const snapshot = this.result?.stages[index] ?? null;
      const running = this.busy && progress?.id === id;
      const selected = Boolean(this.result) && this.selectedStage === index;
      const nonInfo = snapshot
        ? snapshot.issues.filter((issue) => issue.severity !== 'info')
        : [];
      const issues = nonInfo.length;
      const issueTitle = nonInfo
        .map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`)
        .join(' ');
      const issueSeverity = nonInfo.some((issue) => issue.severity === 'error') ? 'error' : 'warn';
      const primaryIssue = nonInfo.find((issue) => issue.severity === 'error') ?? nonInfo[0];
      const metric = snapshot
        ? stageHeadline(snapshot)
        : running
          ? progress?.phase === 'start' ? 'Running' : 'Done'
          : 'Not run';
      const classes = [
        'step-item',
        snapshot ? `is-${snapshot.status}` : 'is-empty',
        running ? 'is-active' : '',
        selected ? 'is-selected' : '',
      ].filter(Boolean).join(' ');
      return `
        <li class="${classes}" data-step="${index}" ${selected ? 'aria-current="step"' : ''} ${issueTitle ? `title="${escapeHtml(issueTitle)}"` : ''}>
          <span class="step-index">${String(index + 1).padStart(2, '0')}</span>
          <span class="step-body">
            <span class="step-name">${STAGE_LABELS[id]}</span>
            <span class="step-metric">${metric}</span>
            ${primaryIssue ? `<span class="step-reason is-${primaryIssue.severity}">${escapeHtml(primaryIssue.message)}</span>` : ''}
          </span>
          ${issues > 0 ? `<span class="step-issues is-${issueSeverity}">${issues}</span>` : ''}
        </li>
      `;
    });
    this.stepList.innerHTML = items.join('');
    if (this.busy && progress) {
      this.stageProgress.textContent = `${Math.min(progress.index + 1, progress.total)} / ${progress.total} running`;
    } else if (this.result) {
      this.stageProgress.textContent = `${this.result.stages.length} / ${STAGE_ORDER.length} complete`;
    } else {
      this.stageProgress.textContent = 'not run';
    }
  }

  private renderStageHeader(): void {
    const stage = this.currentStage;
    if (!stage) {
      if (this.runFailure) {
        this.stageTitle.textContent = 'Unwrap failed';
        this.stageSubtitle.textContent = this.runFailure;
        return;
      }
      this.stageTitle.textContent = this.busy ? 'Unwrapping' : 'No unwrap yet';
      this.stageSubtitle.textContent = this.raw
        ? 'Run the unwrap to inspect every stage.'
        : 'Import a model, run the unwrap, then step through every stage.';
      return;
    }
    const nonInfo = stage.issues.filter((issue) => issue.severity !== 'info');
    const primary = nonInfo.find((issue) => issue.severity === 'error') ?? nonInfo[0];
    this.stageTitle.textContent = `${stage.index + 1}. ${stage.label}`;
    const issueText = nonInfo.length === 0 ? 'no issues' : `${nonInfo.length} issue${nonInfo.length === 1 ? '' : 's'}`;
    this.stageSubtitle.textContent = `${STAGE_DESCRIPTIONS[stage.id]} ${formatDuration(stage.durationMs)} - ${issueText}${primary ? `: ${primary.message}` : ''}`;
  }

  private renderControls(): void {
    const stage = this.currentStage;
    this.viewMode.replaceChildren();
    if (!stage) {
      this.viewMode.disabled = true;
      this.toggleSeams.disabled = true;
      this.toggleWireframe.disabled = true;
      this.clearChart.disabled = true;
      return;
    }
    const modes = STAGE_VIEW_MODES[stage.id];
    if (!modes.includes(this.viewModeValue)) {
      this.viewModeValue = STAGE_DEFAULT_VIEW[stage.id];
    }
    for (const mode of modes) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = VIEW_LABELS[mode];
      this.viewMode.append(option);
    }
    this.viewMode.value = this.viewModeValue;
    this.viewMode.disabled = this.busy;
    this.toggleSeams.checked = this.showSeams;
    this.toggleSeams.disabled = this.busy;
    this.toggleWireframe.checked = this.showWireframe;
    this.toggleWireframe.disabled = this.busy;
    this.clearChart.disabled = this.busy || this.selectedChart === null;
  }

  private renderViewport(): void {
    const stage = this.currentStage;
    this.viewport.setState({
      stage,
      mesh: this.result?.mesh ?? null,
      topology: this.result?.topology ?? null,
      mode: this.viewModeValue,
      selectedChart: this.selectedChart,
      showSeams: this.showSeams,
      showWireframe: this.showWireframe,
      faceOverlap: stage?.id === 'validate' ? this.result?.validation.faceOverlap ?? null : null,
    });
    if (!this.result) {
      this.viewportHud.textContent = this.raw ? 'Model ready. Run the unwrap.' : 'No mesh loaded';
      return;
    }
    const descriptions: Record<StageViewMode, string> = {
      clay: 'Clay view - seams in amber, cuts in pink',
      charts: 'Chart colors',
      distortion: 'Angle distortion - blue low, red high',
      area: 'Area distortion - blue low, red high',
      flipped: 'Flipped faces in magenta',
      density: 'Texel density ratio - blue under, red over',
      checker: 'Checker texture - UV scale',
      overlap: 'Overlap texels in red',
    };
    const base = stage?.id === 'condition' && this.viewModeValue === 'clay'
      ? 'Clay view - boundary edges amber, non-manifold red'
      : descriptions[this.viewModeValue];
    const chartText = this.selectedChart === null ? '' : ` - chart ${this.selectedChart}`;
    this.viewportHud.textContent = `${base}${chartText}`;
  }

  private renderAtlas(): void {
    const stage = this.currentStage;
    const mode = atlasModeFor(stage);
    this.atlas.setState({
      stage,
      mode,
      selectedChart: this.selectedChart,
      overlapMask: stage?.id === 'validate' ? stage.overlapMask : null,
    });
    if (!stage) {
      this.atlasHint.textContent = 'Atlas appears after parameterization';
    } else if (mode === 'inventory') {
      this.atlasHint.textContent = `${stage.chartCount} ${stage.chartCount === 1 ? 'chart' : 'charts'} - not flattened at this stage`;
    } else if (mode === 'atlas') {
      const resolution = stage.atlas?.resolution ?? 0;
      const padding = stage.atlas?.padding ?? 0;
      this.atlasHint.textContent = `${resolution} px atlas - ${padding} px padding - click a chart`;
    } else {
      this.atlasHint.textContent = 'Chart gallery - click a chart to inspect it';
    }
  }

  private renderMetrics(): void {
    const stage = this.currentStage;
    const cards = stage ? stageCards(stage) : [];
    if (cards.length === 0) {
      this.metricStrip.innerHTML = '<div class="metric-empty">Stage metrics appear here.</div>';
      return;
    }
    this.metricStrip.innerHTML = cards.map((card) => `
      <div class="metric-card">
        <span class="metric-label">${escapeHtml(card.label)}</span>
        <span class="metric-value">${escapeHtml(card.value)}</span>
        ${card.hint ? `<span class="metric-hint">${escapeHtml(card.hint)}</span>` : ''}
      </div>
    `).join('');
  }

  private renderDetails(): void {
    const stage = this.currentStage;
    if (!stage) {
      this.detailsMeta.textContent = '-';
      this.stageDetails.innerHTML = '<p class="inspector-empty">Stats and issues for the selected stage.</p>';
      return;
    }
    this.detailsMeta.textContent = `Stage ${stage.index + 1} / ${STAGE_ORDER.length}`;
    const stats = Object.entries(stage.stats).map(([key, value]) => `
      <div class="stat-row">
        <span class="stat-key">${escapeHtml(statLabel(key))}</span>
        <span class="stat-value">${escapeHtml(formatStatValue(value))}</span>
      </div>
    `).join('');
    const issues = stage.issues.length === 0
      ? '<p class="detail-empty">No issues at this stage.</p>'
      : stage.issues.map((issue) => `
          <div class="issue-row is-${issue.severity}">
            <span class="issue-severity">${issue.severity.toUpperCase()}</span>
            <span class="issue-message">${escapeHtml(issue.message)}</span>
          </div>
        `).join('');
    this.stageDetails.innerHTML = `
      <div class="stats-grid">${stats}</div>
      <div class="detail-heading">Issues</div>
      <div class="issue-list">${issues}</div>
    `;
  }

  private renderWeaknesses(): void {
    const weaknesses = this.result?.validation.topWeaknesses ?? [];
    this.weaknessMeta.textContent = this.result
      ? `${weaknesses.length} ranked`
      : '-';
    if (!this.result) {
      this.weaknessList.innerHTML = '<p class="inspector-empty">Run the unwrap to rank weak charts.</p>';
      return;
    }
    if (weaknesses.length === 0) {
      this.weaknessList.innerHTML = '<p class="inspector-empty">No ranked weaknesses. Validation passed its thresholds.</p>';
      return;
    }
    this.weaknessList.innerHTML = weaknesses.map((weakness) => `
      <button class="weakness-item is-${weakness.severity}" type="button"
        data-chart="${weakness.chart}" data-kind="${weakness.kind}">
        <span class="weakness-head">
          <span class="weakness-kind">${weakness.kind.toUpperCase()}</span>
          <span class="weakness-chart">Chart ${weakness.chart}</span>
          <span class="weakness-value">${weaknessValue(weakness.kind, weakness.value)}</span>
        </span>
        <span class="weakness-message">${escapeHtml(weakness.message)}</span>
      </button>
    `).join('');
  }

  private renderSummary(): void {
    if (!this.raw) {
      this.runSummary.innerHTML = '<span class="summary-empty">Import a model to begin.</span>';
      return;
    }
    if (!this.result) {
      const detail = this.runFailure
        ? `Run failed: ${this.runFailure}`
        : this.busy ? 'Running the unwrap...' : 'Ready to unwrap.';
      this.runSummary.innerHTML = `
        <span class="summary-model">${escapeHtml(this.modelName)}</span>
        <span class="summary-empty ${this.runFailure ? 'is-error' : ''}">${escapeHtml(detail)}</span>
      `;
      return;
    }
    const result = this.result;
    const status = result.validation.status;
    const findings = summaryFindings(result);
    const weaknessErrors = result.validation.topWeaknesses.filter((weakness) => weakness.severity === 'error').length;
    const alert = status === 'pass' ? '' : `
      <div class="summary-alert is-${status}" role="${status === 'error' ? 'alert' : 'status'}">
        <span class="summary-alert-title">${status === 'error' ? 'Why this failed' : 'Why this warns'}</span>
        ${findings.length > 0
          ? `<ul>${findings.slice(0, 3).map((finding) => `
              <li class="is-${finding.severity}">${escapeHtml(finding.message)}</li>
            `).join('')}</ul>`
          : '<p>Validation returned a non-pass status without a diagnostic.</p>'}
        ${findings.length > 3 ? `<span class="summary-alert-more">+${findings.length - 3} more in Validate.</span>` : ''}
        ${weaknessErrors > 0 ? `<span class="summary-alert-more">${weaknessErrors} weak chart${weaknessErrors === 1 ? '' : 's'} listed in Validate.</span>` : ''}
      </div>
    `;
    this.runSummary.innerHTML = `
      <div class="summary-head">
        <span class="summary-model" title="${escapeHtml(this.modelName)}">${escapeHtml(this.modelName)}</span>
        <span class="status-badge is-${status}">${status.toUpperCase()}</span>
      </div>
      ${alert}
      <dl class="summary-grid">
        <div><dt>Charts</dt><dd>${result.pack.charts.length}</dd></div>
        <div><dt>Density</dt><dd>${Math.round(result.pack.achievedTexelDensity)} px/u</dd></div>
        <div><dt>Occupancy</dt><dd>${(result.pack.occupancy * 100).toFixed(1)}%</dd></div>
        <div><dt>Overlap</dt><dd>${(Number(result.validation.stats.overlapFraction ?? 0) * 100).toFixed(2)}%</dd></div>
      </dl>
      ${this.runFailure ? '<p class="summary-dirty is-error">Last run failed. Showing the previous result.</p>' : ''}
      ${this.settingsDirty ? '<p class="summary-dirty">Settings changed. Re-run to apply.</p>' : ''}
    `;
  }

  private renderBusy(): void {
    this.busyOverlay.hidden = !this.busy;
    this.stageColumn.setAttribute('aria-busy', String(this.busy));
    if (!this.busy) return;
    if (this.progress) {
      const label = STAGE_LABELS[this.progress.id];
      const current = Math.min(this.progress.index + 1, this.progress.total);
      this.busyText.textContent = `${label} - stage ${current} / ${this.progress.total}`;
    } else {
      this.busyText.textContent = 'Working';
    }
  }

  private renderExportButtons(): void {
    const ready = Boolean(this.result) && !this.busy;
    this.runButton.disabled = !this.raw || this.busy;
    this.exportObjButton.disabled = !ready;
    this.exportGlbButton.disabled = !ready;
    this.exportReportButton.disabled = !ready;
  }

  private scheduleHistogram(): void {
    if (this.histogramFrame) cancelAnimationFrame(this.histogramFrame);
    this.histogramFrame = requestAnimationFrame(() => {
      this.histogramFrame = 0;
      this.renderHistogram();
    });
  }

  private renderHistogram(): void {
    const stage = this.currentStage;
    if (!stage) {
      this.histogramMeta.textContent = '-';
      renderHistogram(this.histogram, null, { max: 1, color: '#2dd4bf', label: 'no stage' });
      return;
    }
    if (this.viewModeValue === 'flipped' && stage.face.flipped && stage.chartOfTriangle) {
      const totals = new Uint32Array(stage.chartCount);
      const flipped = new Uint32Array(stage.chartCount);
      for (let triangle = 0; triangle < stage.face.flipped.length; triangle += 1) {
        const chart = stage.chartOfTriangle[triangle];
        if (chart >= totals.length) continue;
        totals[chart] += 1;
        if (stage.face.flipped[triangle]) flipped[chart] += 1;
      }
      const fractions = new Float32Array(stage.chartCount);
      for (let chart = 0; chart < fractions.length; chart += 1) {
        fractions[chart] = totals[chart] > 0 ? flipped[chart] / totals[chart] : 0;
      }
      this.histogramMeta.textContent = 'flipped fraction';
      renderHistogram(this.histogram, fractions, {
        max: 1,
        color: '#ff5bb5',
        label: 'flipped fraction by chart',
      });
      return;
    }
    if (this.viewModeValue === 'area' && stage.face.areaDistortion) {
      this.histogramMeta.textContent = 'area ratio';
      renderHistogram(this.histogram, stage.face.areaDistortion, {
        max: 3,
        color: '#f08a5d',
        label: 'area distortion (ratio)',
        p95: true,
      });
      return;
    }
    if (stage.id === 'parameterize' && stage.face.angleDistortion) {
      this.histogramMeta.textContent = 'angle deg';
      renderHistogram(this.histogram, stage.face.angleDistortion, {
        max: 30,
        color: '#f08a5d',
        label: 'angle distortion (deg)',
        p95: true,
      });
      return;
    }
    const reference = Number(
      stage.stats.achievedDensity
      ?? stage.stats.targetDensity
      ?? stage.stats.densityP50
      ?? 1,
    ) || 1;
    const densities = stage.face.texelDensity;
    if (densities) {
      const ratios = new Float32Array(densities.length);
      for (let index = 0; index < densities.length; index += 1) {
        ratios[index] = densities[index] / reference;
      }
      this.histogramMeta.textContent = 'density ratio';
      renderHistogram(this.histogram, ratios, {
        max: 2,
        color: '#2dd4bf',
        label: 'texel density ratio',
        p95: true,
      });
      return;
    }
    this.histogramMeta.textContent = '-';
    renderHistogram(this.histogram, null, { max: 1, color: '#2dd4bf', label: 'no data' });
  }

  private exportAsObj(): void {
    if (!this.result) return;
    const mesh = buildExportMesh(this.result.mesh, this.result.pack.triangleUvs);
    const text = exportObj(mesh, {
      name: this.modelName,
      version: BUILD_VERSION,
      input: this.modelName,
    });
    this.download(`${this.modelStem()}_unwrapped.obj`, text, 'text/plain');
    this.showToast('OBJ exported.');
  }

  private exportAsGlb(): void {
    if (!this.result) return;
    const mesh = buildExportMesh(this.result.mesh, this.result.pack.triangleUvs);
    const bytes = exportGlb(mesh, {
      name: this.modelName,
      version: BUILD_VERSION,
      input: this.modelName,
    });
    this.download(`${this.modelStem()}_unwrapped.glb`, bytes, 'model/gltf-binary');
    this.showToast('GLB exported.');
  }

  private exportReportJson(): void {
    if (!this.result) return;
    this.download(`${this.modelStem()}.unwrap.json`, serializeReport(this.result.report), 'application/json');
    this.showToast('Report exported.');
  }

  private modelStem(): string {
    const base = this.modelName.replace(/\\/g, '/').split('/').pop() ?? 'mesh';
    return base.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'mesh';
  }

  private download(name: string, data: string | Uint8Array, type: string): void {
    const blob = new Blob([data as unknown as BlobPart], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private showToast(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    window.clearTimeout(this.toastTimer);
    this.toast.textContent = message;
    this.toast.className = `toast is-${kind}`;
    this.toast.hidden = false;
    this.toastTimer = window.setTimeout(() => {
      this.toast.hidden = true;
    }, 4500);
  }
}
