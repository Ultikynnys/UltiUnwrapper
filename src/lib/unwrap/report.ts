import type { UnwrapConfig } from './config';
import type {
  ConditionedMesh,
  Issue,
  PackResult,
  ParameterizeResult,
  StageId,
  StageStats,
  UnwrapMethod,
} from './types';
import type { ValidationResult, Weakness } from './validate';

export type StageReport = {
  id: StageId;
  label: string;
  durationMs: number;
  stats: StageStats;
  issues: Issue[];
};

export type ReportStageInput = {
  id: StageId;
  label: string;
  durationMs: number;
  stats: StageStats;
  issues: Issue[];
};

export type UnwrapReport = {
  tool: 'UltiUnwrapper';
  schema: 1;
  version: string;
  input: string;
  output: string | null;
  config: UnwrapConfig;
  method: UnwrapMethod;
  mesh: {
    vertices: number;
    triangles: number;
    objects: string[];
  };
  stages: StageReport[];
  summary: {
    status: ValidationResult['status'];
    charts: number;
    atlas: {
      resolution: number;
      padding: number;
      scale: number;
      occupancy: number;
      placements: number;
    };
    texelDensity: {
      target: number;
      achieved: number;
      p50: number;
      spread: number;
    };
    distortion: {
      angleP50: number;
      angleP95: number;
      angleMax: number;
      areaP95: number;
      flipped: number;
    };
    overlap: {
      fraction: number;
      texels: number;
      coveredTexels: number;
      resolution: number;
    };
    weaknesses: Weakness[];
  };
};

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function sanitizeStats(stats: StageStats): Record<string, number | string | boolean | null> {
  const result: Record<string, number | string | boolean | null> = {};
  for (const [key, value] of Object.entries(stats)) {
    result[key] = typeof value === 'number' ? finite(value) : value;
  }
  return result;
}

export type BuildReportInput = {
  version: string;
  input: string;
  output: string | null;
  config: UnwrapConfig;
  mesh: ConditionedMesh;
  stages: ReportStageInput[];
  validation: ValidationResult;
  pack: PackResult;
  parameterization: ParameterizeResult;
};

export function buildReport(input: BuildReportInput): UnwrapReport {
  const { validation, pack, parameterization } = input;
  return {
    tool: 'UltiUnwrapper',
    schema: 1,
    version: input.version,
    input: input.input,
    output: input.output,
    config: input.config,
    method: input.config.method,
    mesh: {
      vertices: input.mesh.vertexCount,
      triangles: input.mesh.triangleCount,
      objects: [...input.mesh.objectNames],
    },
    stages: input.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      durationMs: Number(stage.durationMs.toFixed(3)),
      stats: sanitizeStats(stage.stats),
      issues: stage.issues,
    })),
    summary: {
      status: validation.status,
      charts: parameterization.charts.length,
      atlas: {
        resolution: Number(pack.stats.atlasResolution ?? 0),
        padding: Number(pack.stats.padding ?? 0),
        scale: Number(pack.scale.toFixed(6)),
        occupancy: Number(pack.occupancy.toFixed(6)),
        placements: pack.placements.length,
      },
      texelDensity: {
        target: Number(pack.stats.targetDensity ?? 0),
        achieved: Number(pack.achievedTexelDensity.toFixed(4)),
        p50: Number((pack.stats.densityP50 as number) ?? 0),
        spread: Number(validation.stats.densitySpread ?? 0),
      },
      distortion: {
        angleP50: Number((validation.stats.angleP50 as number) ?? 0),
        angleP95: Number((validation.stats.angleP95 as number) ?? 0),
        angleMax: Number((validation.stats.angleMax as number) ?? 0),
        areaP95: Number((validation.stats.areaP95 as number) ?? 0),
        flipped: Number(validation.stats.flipped ?? 0),
      },
      overlap: {
        fraction: Number(validation.stats.overlapFraction ?? 0),
        texels: Number(validation.stats.overlapTexels ?? 0),
        coveredTexels: Number(validation.stats.coveredTexels ?? 0),
        resolution: Number(validation.stats.validationResolution ?? 0),
      },
      weaknesses: validation.topWeaknesses,
    },
  };
}

export function serializeReport(report: UnwrapReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Compact summary printed by `--json`; the full report stays on disk. */
export function reportSummary(report: UnwrapReport): Record<string, unknown> {
  return {
    tool: report.tool,
    version: report.version,
    status: report.summary.status,
    method: report.method,
    input: report.input,
    output: report.output,
    charts: report.summary.charts,
    atlas: report.summary.atlas,
    texelDensity: report.summary.texelDensity,
    distortion: report.summary.distortion,
    overlap: report.summary.overlap,
    weaknesses: report.summary.weaknesses.length,
    stageTimings: report.stages.map((stage) => ({ id: stage.id, durationMs: stage.durationMs })),
  };
}
