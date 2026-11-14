/**
 * UltiUnwrapper CLI core. Runs the same staged pipeline as the app, writes the
 * final mesh plus optional report and stage artifacts, and exits non-zero when
 * `--check` thresholds fail.
 */
import { BUILD_VERSION } from '../src/lib/buildInfo';
import { flattenScene } from '../src/lib/threeGeometry';
import {
  STAGE_ORDER,
  serializePreset,
  stageIndex,
  type UnwrapConfig,
} from '../src/lib/unwrap/config';
import { buildExportMesh } from '../src/lib/unwrap/exportMesh';
import { exportGlb } from '../src/lib/unwrap/exportGlb';
import { exportObj } from '../src/lib/unwrap/exportObj';
import { runUnwrap, type UnwrapResult } from '../src/lib/unwrap/pipeline';
import { reportSummary, serializeReport } from '../src/lib/unwrap/report';
import { renderChartsSvg } from '../src/lib/unwrap/svg';
import { buildConfig, CliError, configHelp, parseCli, stageHelp, type CliFormat, type CliOptions } from './config';
import { cliHost } from './host';
import { basename, dirname, extname, join } from './path';
import { loadModel } from './model';

const HELP = `UltiUnwrapper CLI  instrumented UV unwrapping

Usage:
  ultiunwrapper -i <model> [-o <model>] [options]

Input / output:
  -i, --input <file>         FBX, OBJ, glTF, or GLB model
  -o, --output <file>        Output mesh (default <input>_unwrapped.obj)
      --format <obj|glb>     Output format (inferred from -o when omitted)
      --report <file>        Write the JSON unwrap report
      --dump-stages <dir>    Write per-stage JSON, OBJ, and SVG artifacts
      --stage <id>           Stop writing after this stage
      --validate-only        Run all stages but skip the mesh export

Config:
      --preset <file>        Load an unwrap preset JSON
      --dump-config [<file>] Write resolved settings and exit
${configHelp()}

Info:
      --list-stages          List stage ids and exit
      --json                 Print a machine-readable summary
      --check                Exit 1 when validation crosses a threshold
      --version              Print the version and exit
  -h, --help                 Show this help

Stages:
${stageHelp()}
`;

function jsonSafe(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === 'number' && !Number.isFinite(item) ? null : item),
    2,
  );
}

function resolveFormat(options: CliOptions, output: string | null): CliFormat {
  if (options.format) return options.format;
  return output && extname(output).toLowerCase() === '.glb' ? 'glb' : 'obj';
}

function outputPath(options: CliOptions, input: string, format: CliFormat): string {
  if (options.output) return options.output;
  return join(dirname(input), `${basename(input, extname(input))}_unwrapped.${format}`);
}

function stageLimit(options: CliOptions): number {
  return options.stage ? stageIndex(options.stage) : STAGE_ORDER.length - 1;
}

async function writeStageArtifacts(
  result: UnwrapResult,
  directory: string,
  inputName: string,
  limit: number,
): Promise<string[]> {
  const host = cliHost();
  const written: string[] = [];
  for (const stage of result.stages) {
    if (stage.index > limit) continue;
    const number = String(stage.index + 1).padStart(2, '0');
    const stem = join(directory, `stage-${number}-${stage.id}`);
    const jsonPath = `${stem}.json`;
    const summary = {
      id: stage.id,
      label: stage.label,
      durationMs: Number(stage.durationMs.toFixed(3)),
      status: stage.status,
      stats: stage.stats,
      issues: stage.issues,
      chartCount: stage.chartCount,
    };
    await host.writeFileBytes(host.resolvePath(jsonPath), new TextEncoder().encode(`${jsonSafe(summary)}\n`));
    written.push(jsonPath);

    if (stage.uvs) {
      const exportMesh = buildExportMesh(result.mesh, stage.uvs);
      const obj = exportObj(exportMesh, {
        name: `${inputName}-${stage.id}`,
        version: BUILD_VERSION,
        input: inputName,
      });
      const objPath = `${stem}.obj`;
      await host.writeFileBytes(host.resolvePath(objPath), new TextEncoder().encode(obj));
      written.push(objPath);
    }
    if (stage.charts && stage.charts.length > 0) {
      const svg = renderChartsSvg(stage.charts, {
        atlas: stage.id === 'pack' || stage.id === 'validate',
        placements: stage.atlas?.placements,
        atlasResolution: stage.atlas?.resolution,
        title: `${number}. ${stage.label}`,
      });
      const svgPath = `${stem}.svg`;
      await host.writeFileBytes(host.resolvePath(svgPath), new TextEncoder().encode(svg));
      written.push(svgPath);
    }
  }
  return written;
}

function humanResult(
  result: UnwrapResult,
  input: string,
  output: string | null,
  report: string | null,
): string {
  const status = result.validation.status.toUpperCase();
  const summary = result.report.summary;
  const lines = [
    `UltiUnwrapper ${BUILD_VERSION}`,
    `${input}${output ? ` -> ${output}` : ' (mesh export skipped)'}`,
    `${summary.charts} charts | density ${summary.texelDensity.target} -> ${summary.texelDensity.achieved.toFixed(1)} px/unit | angle p95 ${summary.distortion.angleP95.toFixed(2)} deg | overlap ${(summary.overlap.fraction * 100).toFixed(3)}% | occupancy ${(summary.atlas.occupancy * 100).toFixed(1)}% | ${status}`,
  ];
  if (report) lines.push(`report: ${report}`);
  return `${lines.join('\n')}\n`;
}

export async function runCli(argv: string[]): Promise<number> {
  const host = cliHost();
  let options: CliOptions;
  try {
    const wantsHelp = argv.includes('--help') || argv.includes('-h');
    const wantsVersion = argv.includes('--version');
    const wantsStages = argv.includes('--list-stages');
    options = parseCli(wantsHelp ? ['--help'] : wantsVersion ? ['--version'] : wantsStages ? ['--list-stages'] : argv);
  } catch (error) {
    if (error instanceof CliError) {
      host.error(`error: ${error.message}\n`);
      await host.flush();
      return 2;
    }
    throw error;
  }

  if (options.help) {
    host.log(HELP);
    await host.flush();
    return 0;
  }
  if (options.version) {
    host.log(`UltiUnwrapper ${BUILD_VERSION}\n`);
    await host.flush();
    return 0;
  }
  if (options.listStages) {
    host.log(`Stages:\n${stageHelp()}\n`);
    await host.flush();
    return 0;
  }

  let config: UnwrapConfig;
  try {
    config = await buildConfig(options);
  } catch (error) {
    if (error instanceof CliError) {
      host.error(`error: ${error.message}\n`);
      await host.flush();
      return 2;
    }
    throw error;
  }

  if (options.dumpConfig !== null) {
    const target = options.dumpConfig
      || (options.input
        ? join(dirname(options.input), `${basename(options.input, extname(options.input))}.unwrap.json`)
        : 'ultiunwrapper-preset.json');
    const name = basename(target, extname(target));
    const resolved = host.resolvePath(target);
    await host.writeFileBytes(resolved, new TextEncoder().encode(serializePreset(config, name)));
    host.log(`Wrote preset: ${resolved}\n`);
    await host.flush();
    return 0;
  }

  if (!options.input) {
    host.error('error: --input <file> is required. Try --help.\n');
    await host.flush();
    return 2;
  }

  const input = options.input;
  const format = resolveFormat(options, options.output);
  const output = outputPath(options, input, format);
  const limit = stageLimit(options);
  const willWrite = !options.validateOnly && limit >= stageIndex('pack');
  const reportPath = options.report ? host.resolvePath(options.report) : null;

  let result: UnwrapResult;
  try {
    const scene = await loadModel(host.resolvePath(input));
    const flattened = flattenScene(scene);
    if (flattened.mesh.indices.length === 0) {
      throw new CliError('The model has no visible triangles.');
    }
    result = runUnwrap(flattened.mesh, config, {
      version: BUILD_VERSION,
      inputName: basename(input),
      output: willWrite ? output : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.error(`error: ${message}\n`);
    await host.flush();
    return 2;
  }

  if (willWrite) {
    const exportMesh = buildExportMesh(result.mesh, result.pack.triangleUvs);
    const name = basename(output, extname(output));
    const bytes = format === 'glb'
      ? exportGlb(exportMesh, { name, version: BUILD_VERSION, input: basename(input) })
      : new TextEncoder().encode(exportObj(exportMesh, { name, version: BUILD_VERSION, input: basename(input) }));
    await host.writeFileBytes(host.resolvePath(output), bytes);
  }

  if (reportPath) {
    await host.writeFileBytes(reportPath, new TextEncoder().encode(serializeReport(result.report)));
  }

  if (options.dumpStages) {
    await writeStageArtifacts(result, options.dumpStages, basename(input), limit);
  }

  if (options.json) {
    host.log(`${jsonSafe(reportSummary(result.report))}\n`);
  } else {
    host.log(humanResult(result, input, willWrite ? output : null, reportPath));
  }

  if (options.check && result.validation.status === 'error') {
    for (const issue of result.validation.issues) {
      if (issue.severity === 'error') host.error(`check: ${issue.message}\n`);
    }
    await host.flush();
    return 1;
  }

  await host.flush();
  return 0;
}
