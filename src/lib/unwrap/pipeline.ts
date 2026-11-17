import { buildReport, type UnwrapReport } from './report';
import {
  STAGE_LABELS,
  stageIndex,
  stagePlan,
  type UnwrapConfig,
} from './config';
import { normalizeDensity, buildDensityArrays, densitySpread } from './density';
import { computeFaceMetrics, summarize } from './metrics';
import { conditionMesh, computeFaceGeometry, type FaceGeometry } from './mesh';
import { packAtlas, type PackResult } from './pack';
import { refineUnwrap } from './refine';
import { buildSmartIslands, equalizeSmartDensity, fitSmartIslands, projectSmart } from './smartProject';
import type { RefineRunner } from './smartProject';
import { buildTopology, topologyStats } from './topology';
import type {
  AtlasInfo,
  ChartUv,
  ConditionedMesh,
  DensityResult,
  Issue,
  MeshTopology,
  ParameterizeResult,
  RawMesh,
  Segmentation,
  StageSnapshot,
  StageStats,
  StageStatus,
  StageId,
} from './types';
import type { ValidationResult, ValidationStatus } from './validate';
import { validateUnwrap } from './validate';

export type RunProgress = {
  id: StageId;
  index: number;
  total: number;
  phase: 'start' | 'done';
  durationMs?: number;
};

export type RunOptions = {
  version?: string;
  inputName?: string;
  output?: string;
  /** Keep input UV islands when available. Set false to force new seams. */
  preserveSourceUvs?: boolean;
  refineRunner?: RefineRunner;
  onProgress?: (progress: RunProgress) => void;
};

export type UnwrapResult = {
  config: UnwrapConfig;
  mesh: ConditionedMesh;
  topology: MeshTopology;
  face: FaceGeometry;
  segmentation: Segmentation;
  parameterization: ParameterizeResult;
  density: DensityResult;
  pack: PackResult;
  validation: ValidationResult;
  stages: StageSnapshot[];
  report: UnwrapReport;
};

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function stageStatus(issues: Issue[]): StageStatus {
  if (issues.some((issue) => issue.severity === 'error')) return 'error';
  if (issues.some((issue) => issue.severity === 'warn')) return 'warn';
  return 'ok';
}

function validationStatus(status: ValidationStatus): StageStatus {
  return status === 'pass' ? 'ok' : status;
}

function edgeIds(mask: Uint8Array): Uint32Array {
  const ids: number[] = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) ids.push(index);
  }
  return new Uint32Array(ids);
}

function atlasInfo(pack: PackResult): AtlasInfo {
  return {
    resolution: Number(pack.stats.atlasResolution ?? 0),
    padding: Number(pack.stats.padding ?? 0),
    scale: pack.scale,
    occupancy: pack.occupancy,
    placements: pack.placements,
  };
}

/** Runs the complete instrumented pipeline. Every stage keeps its own snapshot,
 * so the UI can replay the run after it finishes and the CLI can dump each
 * intermediate result. */
export async function runUnwrap(raw: RawMesh, config: UnwrapConfig, options: RunOptions = {}): Promise<UnwrapResult> {
  const stages: StageSnapshot[] = [];
  const method = config.method;
  const total = stagePlan(method).length;
  const emit = (id: StageId, phase: 'start' | 'done', durationMs?: number): void => {
    options.onProgress?.({ id, index: stageIndex(id, method), total, phase, durationMs });
  };

  let started = clock();
  emit('condition', 'start');
  const condition = conditionMesh(raw, { weldEpsilon: config.weldEpsilon });
  const topology = buildTopology(condition.mesh);
  const topologyCounts = topologyStats(topology);
  const conditionIssues: Issue[] = [...condition.issues];
  if (topologyCounts.nonManifoldEdges > 0) {
    conditionIssues.push({
      stage: 'condition',
      severity: 'warn',
      code: 'non-manifold-topology',
      message: `${topologyCounts.nonManifoldEdges} non-manifold edge${topologyCounts.nonManifoldEdges === 1 ? '' : 's'} in the input.`,
      value: topologyCounts.nonManifoldEdges,
    });
  }
  const conditionStats = { ...condition.stats, ...topologyCounts };
  const conditionDuration = clock() - started;
  stages.push({
    id: 'condition',
    index: stageIndex('condition', method),
    label: STAGE_LABELS.condition,
    durationMs: conditionDuration,
    status: stageStatus(conditionIssues),
    stats: conditionStats,
    issues: conditionIssues,
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
  });
  emit('condition', 'done', conditionDuration);

  const face = computeFaceGeometry(condition.mesh);
  let segmentation: Segmentation;
  let parameterization: ParameterizeResult;
  let density: DensityResult;

  if (method === 'smart') {
    started = clock();
    emit('project', 'start');
    const projection = projectSmart(condition.mesh, face, {
      angleLimit: config.projectionAngleLimit,
      areaWeight: config.projectionAreaWeight,
    });
    const projectDuration = clock() - started;
    stages.push({
      id: 'project',
      index: stageIndex('project', method),
      label: STAGE_LABELS.project,
      durationMs: projectDuration,
      status: stageStatus(projection.issues),
      stats: projection.stats,
      issues: projection.issues,
      uvs: projection.triangleUvs,
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
    });
    emit('project', 'done', projectDuration);

    started = clock();
    emit('islands', 'start');
    const islands = await buildSmartIslands(condition.mesh, topology, face, projection, {
      splitByObject: config.splitByObject,
      splitByMaterial: config.splitByMaterial,
      maxDensitySpread: config.thresholds.maxDensitySpread,
      budgetMs: config.refineBudgetMs,
    }, options.refineRunner);
    const islandMetrics = computeFaceMetrics(condition.mesh, islands.charts, islands.triangleUvs);
    const islandAngle = summarize(islandMetrics.angleDistortion);
    const islandArea = summarize(islandMetrics.areaDistortion);
    let islandFlipped = 0;
    for (const value of islandMetrics.flipped) islandFlipped += value;
    const islandIssues: Issue[] = [...islands.issues];
    const islandDuration = clock() - started;
    stages.push({
      id: 'islands',
      index: stageIndex('islands', method),
      label: STAGE_LABELS.islands,
      durationMs: islandDuration,
      status: stageStatus(islandIssues),
      stats: {
        ...islands.stats,
        angleP50: Number(islandAngle.p50.toFixed(4)),
        angleP95: Number(islandAngle.p95.toFixed(4)),
        areaP50: Number(islandArea.p50.toFixed(4)),
        areaP95: Number(islandArea.p95.toFixed(4)),
        flipped: islandFlipped,
        failedCharts: 0,
        harmonicCharts: 0,
      },
      issues: islandIssues,
      uvs: islands.triangleUvs,
      chartOfTriangle: islands.chartOfTriangle,
      chartCount: islands.charts.length,
      seamEdges: edgeIds(islands.seamEdge),
      cutEdges: new Uint32Array(0),
      charts: islands.charts,
      atlas: null,
      face: {
        angleDistortion: islandMetrics.angleDistortion,
        areaDistortion: islandMetrics.areaDistortion,
        flipped: islandMetrics.flipped,
      },
      overlapMask: null,
      overlapWidth: 0,
      overlapHeight: 0,
      weaknesses: [],
    });
    emit('islands', 'done', islandDuration);

    segmentation = {
      seamEdge: islands.seamEdge,
      cutEdgeIndices: new Uint32Array(0),
      charts: islands.charts.map((chart) => ({
        id: chart.chart,
        triangles: chart.triangles,
        localIndices: chart.localIndices,
        localVertex: chart.localVertex,
        worldArea: chart.worldArea,
        boundaryEdges: [],
        boundaryComponents: 0,
        closed: false,
      })),
      chartOfTriangle: islands.chartOfTriangle,
      stats: islands.stats,
      issues: islandIssues,
    };

    started = clock();
    emit('normalize', 'start');
    const fit = fitSmartIslands(islands.charts, islands.triangleUvs);
    const equalized = equalizeSmartDensity(condition.mesh, fit.charts, face, config.atlasResolution);
    const fitMetrics = computeFaceMetrics(condition.mesh, equalized.charts, equalized.triangleUvs);
    const fitAngle = summarize(fitMetrics.angleDistortion);
    const fitArea = summarize(fitMetrics.areaDistortion);
    let fitFlipped = 0;
    for (const value of fitMetrics.flipped) fitFlipped += value;
    const densityArrays = buildDensityArrays(
      condition.mesh,
      equalized.charts,
      face,
      config.atlasResolution,
      0,
    );
    const referenceDensity = densityArrays.summary.p50 > 0 ? densityArrays.summary.p50 : 0;
    const densityRatio = new Float32Array(densityArrays.densityRatio.length);
    for (let index = 0; index < densityRatio.length; index += 1) {
      densityRatio[index] = referenceDensity > 0
        ? densityArrays.faceTexelDensity[index] / referenceDensity
        : 0;
    }
    let requiredArea = 0;
    for (const chart of equalized.charts) requiredArea += chart.uvArea;
    const normalizeIssues: Issue[] = [];
    if (config.targetTexelDensity > 0) {
      normalizeIssues.push({
        stage: 'normalize',
        severity: 'info',
        code: 'smart-density-fit',
        message: `Smart projection fits the atlas at ${referenceDensity.toFixed(1)} px/unit; the requested target is reported, not enforced.`,
        value: Number(referenceDensity.toFixed(4)),
      });
    }
    const densityStats: StageStats = {
      charts: equalized.charts.length,
      atlasResolution: config.atlasResolution,
      targetDensity: config.targetTexelDensity,
      fitScale: Number(fit.scale.toFixed(6)),
      requiredAreaFraction: Number(requiredArea.toFixed(6)),
      densityBeforeSpread: Number(densitySpread(densityArrays.faceTexelDensity).toFixed(6)),
      densityAfterSpread: Number(densitySpread(densityArrays.faceTexelDensity).toFixed(6)),
      densityP50: Number(densityArrays.summary.p50.toFixed(4)),
      densityP95: Number(densityArrays.summary.p95.toFixed(4)),
      scaleMin: Number(equalized.scaleMin.toFixed(6)),
      scaleMax: Number(equalized.scaleMax.toFixed(6)),
      clampedCharts: 0,
    };
    density = {
      charts: equalized.charts,
      triangleUvs: equalized.triangleUvs,
      faceTexelDensity: densityArrays.faceTexelDensity,
      densityRatio,
      chartScales: equalized.scales,
      stats: densityStats,
      issues: normalizeIssues,
    };
    parameterization = {
      charts: equalized.charts,
      triangleUvs: equalized.triangleUvs,
      angleDistortion: fitMetrics.angleDistortion,
      areaDistortion: fitMetrics.areaDistortion,
      flipped: fitMetrics.flipped,
      stats: {
        charts: equalized.charts.length,
        angleP50: Number(fitAngle.p50.toFixed(4)),
        angleP95: Number(fitAngle.p95.toFixed(4)),
        areaP50: Number(fitArea.p50.toFixed(4)),
        areaP95: Number(fitArea.p95.toFixed(4)),
        flipped: fitFlipped,
        failedCharts: 0,
        harmonicCharts: 0,
      },
      issues: [],
    };
    const normalizeDuration = clock() - started;
    stages.push({
      id: 'normalize',
      index: stageIndex('normalize', method),
      label: STAGE_LABELS.normalize,
      durationMs: normalizeDuration,
      status: stageStatus(normalizeIssues),
      stats: densityStats,
      issues: normalizeIssues,
      uvs: equalized.triangleUvs,
      chartOfTriangle: islands.chartOfTriangle,
      chartCount: equalized.charts.length,
      seamEdges: edgeIds(islands.seamEdge),
      cutEdges: new Uint32Array(0),
      charts: equalized.charts,
      atlas: null,
      face: {
        angleDistortion: fitMetrics.angleDistortion,
        areaDistortion: fitMetrics.areaDistortion,
        texelDensity: densityArrays.faceTexelDensity,
        densityRatio,
        flipped: fitMetrics.flipped,
      },
      overlapMask: null,
      overlapWidth: 0,
      overlapHeight: 0,
      weaknesses: [],
    });
    emit('normalize', 'done', normalizeDuration);
  } else {
    emit('segment', 'start');
    const preserveSourceUvs = options.preserveSourceUvs !== false && Boolean(condition.mesh.triangleUvs);
    const refinement = refineUnwrap(condition.mesh, topology, face, {
      seamAngle: preserveSourceUvs ? 180 : config.seamAngle,
      splitByObject: config.splitByObject,
      splitByMaterial: config.splitByMaterial,
      useUvSeams: preserveSourceUvs,
      sourceUvs: preserveSourceUvs,
      maxDensitySpread: config.thresholds.maxDensitySpread,
      tolerance: config.tolerance,
      maxIterations: config.maxIterations,
      maxFlippedFraction: config.maxFlippedFraction,
    });
    segmentation = refinement.segmentation;
    parameterization = refinement.parameterization;
    const segmentDuration = refinement.segmentMs;
    const parameterizeDuration = refinement.parameterizeMs;
    const refineRounds = refinement.rounds;
    const refineSeamsAdded = refinement.addedSeams;
    const refineUnresolved = refinement.unresolved;
    if (preserveSourceUvs) {
      parameterization.issues.push({
        stage: 'parameterize',
        severity: 'info',
        code: 'source-uvs-preserved',
        message: 'Reused the input UV islands and their existing flattening, re-solving charts that needed further cuts.',
        value: parameterization.charts.length,
      });
    }
    const segmentIssues: Issue[] = [...segmentation.issues];
    if (refinement.stalled) {
      segmentIssues.push({
        stage: 'segment',
        severity: 'warn',
        code: 'refine-budget-exhausted',
        message: `Stopped cutting after ${refinement.rounds} rounds with ${refinement.unresolved} chart${refinement.unresolved === 1 ? '' : 's'} still outside the density budget.`,
        value: refinement.unresolved,
      });
    }
    stages.push({
      id: 'segment',
      index: stageIndex('segment', method),
      label: STAGE_LABELS.segment,
      durationMs: segmentDuration,
      status: stageStatus(segmentIssues),
      stats: {
        ...segmentation.stats,
        refineRounds,
        refineSeamsAdded,
        refineUnresolved,
      },
      issues: segmentIssues,
      uvs: null,
      chartOfTriangle: segmentation.chartOfTriangle,
      chartCount: segmentation.charts.length,
      seamEdges: edgeIds(segmentation.seamEdge),
      cutEdges: segmentation.cutEdgeIndices,
      charts: null,
      atlas: null,
      face: {},
      overlapMask: null,
      overlapWidth: 0,
      overlapHeight: 0,
      weaknesses: [],
    });
    emit('segment', 'done', segmentDuration);

    started = clock();
    emit('parameterize', 'start');
    stages.push({
      id: 'parameterize',
      index: stageIndex('parameterize', method),
      label: STAGE_LABELS.parameterize,
      durationMs: parameterizeDuration,
      status: stageStatus(parameterization.issues),
      stats: parameterization.stats,
      issues: parameterization.issues,
      uvs: parameterization.triangleUvs,
      chartOfTriangle: segmentation.chartOfTriangle,
      chartCount: segmentation.charts.length,
      seamEdges: edgeIds(segmentation.seamEdge),
      cutEdges: segmentation.cutEdgeIndices,
      charts: parameterization.charts,
      atlas: null,
      face: {
        angleDistortion: parameterization.angleDistortion,
        areaDistortion: parameterization.areaDistortion,
        flipped: parameterization.flipped,
      },
      overlapMask: null,
      overlapWidth: 0,
      overlapHeight: 0,
      weaknesses: [],
    });
    emit('parameterize', 'done', parameterizeDuration);

    started = clock();
    emit('normalize', 'start');
    density = normalizeDensity(condition.mesh, parameterization, face, {
      atlasResolution: config.atlasResolution,
      targetTexelDensity: config.targetTexelDensity,
    });
    const normalizeDuration = clock() - started;
    stages.push({
      id: 'normalize',
      index: stageIndex('normalize', method),
      label: STAGE_LABELS.normalize,
      durationMs: normalizeDuration,
      status: stageStatus(density.issues),
      stats: density.stats,
      issues: density.issues,
      uvs: density.triangleUvs,
      chartOfTriangle: segmentation.chartOfTriangle,
      chartCount: segmentation.charts.length,
      seamEdges: edgeIds(segmentation.seamEdge),
      cutEdges: segmentation.cutEdgeIndices,
      charts: density.charts,
      atlas: null,
      face: {
        angleDistortion: parameterization.angleDistortion,
        areaDistortion: parameterization.areaDistortion,
        texelDensity: density.faceTexelDensity,
        densityRatio: density.densityRatio,
        flipped: parameterization.flipped,
      },
      overlapMask: null,
      overlapWidth: 0,
      overlapHeight: 0,
      weaknesses: [],
    });
    emit('normalize', 'done', normalizeDuration);
  }

  started = clock();
  emit('pack', 'start');
  const packTargetDensity = method === 'smart'
    ? Number(density.stats.densityP50 ?? 0)
    : config.targetTexelDensity;
  const pack = packAtlas(condition.mesh, density, face, {
    atlasResolution: config.atlasResolution,
    padding: config.padding,
    allowRotation: config.allowRotation,
    fitToAtlas: config.fitToAtlas,
    targetTexelDensity: packTargetDensity,
    occupancyResolution: config.occupancyResolution,
    minOccupancy: config.thresholds.minOccupancy,
  });
  const packDuration = clock() - started;
  const packedAtlas = atlasInfo(pack);
  stages.push({
    id: 'pack',
    index: stageIndex('pack', method),
    label: STAGE_LABELS.pack,
    durationMs: packDuration,
    status: stageStatus(pack.issues),
    stats: pack.stats,
    issues: pack.issues,
    uvs: pack.triangleUvs,
    chartOfTriangle: segmentation.chartOfTriangle,
    chartCount: segmentation.charts.length,
    seamEdges: edgeIds(segmentation.seamEdge),
    cutEdges: segmentation.cutEdgeIndices,
    charts: pack.charts,
    atlas: packedAtlas,
    face: {
      angleDistortion: parameterization.angleDistortion,
      areaDistortion: parameterization.areaDistortion,
      texelDensity: pack.faceTexelDensity,
      flipped: parameterization.flipped,
    },
    overlapMask: null,
    overlapWidth: 0,
    overlapHeight: 0,
    weaknesses: [],
  });
  emit('pack', 'done', packDuration);

  started = clock();
  emit('validate', 'start');
  const validation = validateUnwrap(condition.mesh, parameterization, pack, {
    ...config.thresholds,
    occupancyResolution: config.occupancyResolution,
  });
  const validateDuration = clock() - started;
  stages.push({
    id: 'validate',
    index: stageIndex('validate', method),
    label: STAGE_LABELS.validate,
    durationMs: validateDuration,
    status: validationStatus(validation.status),
    stats: validation.stats,
    issues: validation.issues,
    uvs: pack.triangleUvs,
    chartOfTriangle: segmentation.chartOfTriangle,
    chartCount: segmentation.charts.length,
    seamEdges: edgeIds(segmentation.seamEdge),
    cutEdges: segmentation.cutEdgeIndices,
    charts: pack.charts as ChartUv[],
    atlas: packedAtlas,
    face: {
      angleDistortion: parameterization.angleDistortion,
      areaDistortion: parameterization.areaDistortion,
      texelDensity: pack.faceTexelDensity,
      flipped: parameterization.flipped,
    },
    overlapMask: validation.overlapMask,
    overlapWidth: validation.overlapWidth,
    overlapHeight: validation.overlapHeight,
    weaknesses: validation.topWeaknesses,
  });
  emit('validate', 'done', validateDuration);

  const report = buildReport({
    version: options.version ?? 'dev',
    input: options.inputName ?? 'mesh',
    output: options.output ?? null,
    config,
    mesh: condition.mesh,
    stages: stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      durationMs: stage.durationMs,
      stats: stage.stats,
      issues: stage.issues,
    })),
    validation,
    pack,
    parameterization,
  });

  return {
    config,
    mesh: condition.mesh,
    topology,
    face,
    segmentation,
    parameterization,
    density,
    pack,
    validation,
    stages,
    report,
  };
}
