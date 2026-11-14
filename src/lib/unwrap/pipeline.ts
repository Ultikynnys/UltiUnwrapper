import { buildReport, type UnwrapReport } from './report';
import {
  STAGE_LABELS,
  STAGE_ORDER,
  type UnwrapConfig,
} from './config';
import { segmentMesh } from './charts';
import { normalizeDensity } from './density';
import { conditionMesh, computeFaceGeometry, type FaceGeometry } from './mesh';
import { packAtlas, type PackResult } from './pack';
import { parameterizeMesh } from './parameterize';
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
  const emit = (id: StageId, index: number, phase: 'start' | 'done', durationMs?: number): void => {
    options.onProgress?.({ id, index, total, phase, durationMs });
  };

  let started = clock();
  emit('condition', 0, 'start');
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
    index: 0,
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
  emit('condition', 0, 'done', conditionDuration);

  started = clock();
  emit('segment', 1, 'start');
  const face = computeFaceGeometry(condition.mesh);
  const segmentation = segmentMesh(condition.mesh, topology, face, {
    seamAngle: config.seamAngle,
    splitByObject: config.splitByObject,
    splitByMaterial: config.splitByMaterial,
    maxClosedChartCuts: 3,
  });
  const segmentDuration = clock() - started;
  stages.push({
    id: 'segment',
    index: 1,
    label: STAGE_LABELS.segment,
    durationMs: segmentDuration,
    status: stageStatus(segmentation.issues),
    stats: segmentation.stats,
    issues: segmentation.issues,
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
  emit('segment', 1, 'done', segmentDuration);

  started = clock();
  emit('parameterize', 2, 'start');
  const parameterization = parameterizeMesh(condition.mesh, segmentation, face, topology, {
    tolerance: config.tolerance,
    maxIterations: config.maxIterations,
    maxFlippedFraction: config.maxFlippedFraction,
  });
  const parameterizeDuration = clock() - started;
  stages.push({
    id: 'parameterize',
    index: 2,
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
  emit('parameterize', 2, 'done', parameterizeDuration);

  started = clock();
  emit('normalize', 3, 'start');
  const density = normalizeDensity(condition.mesh, parameterization, face, {
    atlasResolution: config.atlasResolution,
    targetTexelDensity: config.targetTexelDensity,
  });
  const normalizeDuration = clock() - started;
  stages.push({
    id: 'normalize',
    index: 3,
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
  emit('normalize', 3, 'done', normalizeDuration);

  started = clock();
  emit('pack', 4, 'start');
  const pack = packAtlas(condition.mesh, density, face, {
    atlasResolution: config.atlasResolution,
    padding: config.padding,
    allowRotation: config.allowRotation,
    targetTexelDensity: config.targetTexelDensity,
    occupancyResolution: config.occupancyResolution,
    minOccupancy: config.thresholds.minOccupancy,
  });
  const packDuration = clock() - started;
  const packedAtlas = atlasInfo(pack);
  stages.push({
    id: 'pack',
    index: 4,
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
  emit('pack', 4, 'done', packDuration);

  started = clock();
  emit('validate', 5, 'start');
  const validation = validateUnwrap(condition.mesh, parameterization, pack, {
    ...config.thresholds,
    occupancyResolution: config.occupancyResolution,
  });
  const validateDuration = clock() - started;
  stages.push({
    id: 'validate',
    index: 5,
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
  emit('validate', 5, 'done', validateDuration);

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
    density,
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
