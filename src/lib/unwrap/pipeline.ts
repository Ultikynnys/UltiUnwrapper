import { buildReport, type UnwrapReport } from './report';
import {
  STAGE_LABELS,
  STAGE_ORDER,
  stageIndex,
  type UnwrapConfig,
} from './config';
import { normalizeDensity } from './density';
import { conditionMesh, computeFaceGeometry, type FaceGeometry } from './mesh';
import { packAtlas, type PackResult } from './pack';
import { refineUnwrap } from './refine';
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
    bboxOccupancy: pack.bboxOccupancy,
    placements: pack.placements,
  };
}

/** Runs the complete instrumented pipeline. Every stage keeps its own snapshot,
 * so the UI can replay the run after it finishes and the CLI can dump each
 * intermediate result. */
export function runUnwrap(raw: RawMesh, config: UnwrapConfig, options: RunOptions = {}): UnwrapResult {
  const stages: StageSnapshot[] = [];
  const total = STAGE_ORDER.length;
  const emit = (id: StageId, phase: 'start' | 'done', durationMs?: number): void => {
    options.onProgress?.({ id, index: stageIndex(id), total, phase, durationMs });
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
    index: stageIndex('condition'),
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

  emit('segment', 'start');
  const face = computeFaceGeometry(condition.mesh);
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
  const segmentation = refinement.segmentation;
  const parameterization = refinement.parameterization;
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
    index: stageIndex('segment'),
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
    index: stageIndex('parameterize'),
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
  const density = normalizeDensity(condition.mesh, parameterization, face, {
    atlasResolution: config.atlasResolution,
    targetTexelDensity: config.targetTexelDensity,
  });
  const normalizeDuration = clock() - started;
  stages.push({
    id: 'normalize',
    index: stageIndex('normalize'),
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

  started = clock();
  emit('pack', 'start');
  const pack = packAtlas(condition.mesh, density, face, {
    atlasResolution: config.atlasResolution,
    padding: config.padding,
    allowRotation: config.allowRotation,
    fitToAtlas: config.fitToAtlas,
    targetTexelDensity: config.targetTexelDensity,
    occupancyResolution: config.occupancyResolution,
    minOccupancy: config.thresholds.minOccupancy,
  });
  const packDuration = clock() - started;
  const packedAtlas = atlasInfo(pack);
  stages.push({
    id: 'pack',
    index: stageIndex('pack'),
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
    index: stageIndex('validate'),
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
